"""
Unit tests for the process simulator (containers/process-sim/sim.py).

What these cover, and why each one is here rather than being left to a manual run:

  - The external/internal Modbus traffic split. The settle barrier decides when a
    controller has been given its say by counting datastore access. If the
    simulator's own reads and writes ever leaked into those counters, the barrier
    would satisfy itself and every closed-loop episode would silently lose its
    determinism guarantee while still looking correct. This is the single most
    load-bearing invariant in the file.
  - The EpisodeClock grant/drain handshake, including that concurrent steppers
    conserve ticks. A lost or double-counted tick changes a trajectory.
  - Deterministic physics under a pinned seed, and the paired negative control
    that a different seed actually diverges — without which "identical" proves
    nothing.
  - The hand-written HTTP framing and request parsing, which have no framework
    behind them to get the edge cases right.

Async tests drive the event loop with asyncio.run() rather than pytest-asyncio,
so the suite needs only pytest itself. The image ships pymodbus and nothing else,
and a test dependency that exists to avoid four lines of boilerplate is not worth
the supply-chain surface.
"""
import asyncio
import json
import random

import pytest

import sim


# ── helpers ───────────────────────────────────────────────────────────────────

def fresh_store():
    """A datastore with the simulator's normal starting state."""
    state = sim.PhysicsState(volume_l=500.0, level_m=0.5, pressure_bar=0.05)
    return sim.build_store(state), state


class FakeReader:
    """Minimal asyncio.StreamReader stand-in driven by a fixed byte buffer."""

    def __init__(self, data: bytes):
        self._data = data

    async def readline(self) -> bytes:
        idx = self._data.find(b"\n")
        if idx == -1:
            line, self._data = self._data, b""
        else:
            line, self._data = self._data[:idx + 1], self._data[idx + 1:]
        return line

    async def readexactly(self, n: int) -> bytes:
        if len(self._data) < n:
            raise asyncio.IncompleteReadError(self._data, n)
        chunk, self._data = self._data[:n], self._data[n:]
        return chunk


# ── external vs internal traffic accounting ───────────────────────────────────

class TestTrafficCounters:
    """
    The barrier is only meaningful if these counters see the controller and not
    the simulator. Each internal helper gets its own test so a regression names
    the exact caller that started leaking.
    """

    def test_starts_at_zero(self):
        store, _ = fresh_store()
        assert (store.pv_reads, store.coil_writes) == (0, 0)

    def test_write_pvs_does_not_count_as_a_coil_write(self):
        store, state = fresh_store()
        sim.write_pvs(store, state, 0)
        assert store.coil_writes == 0, "internal PV write leaked into the coil counter"

    def test_write_pvs_does_not_count_as_a_pv_read(self):
        store, state = fresh_store()
        sim.write_pvs(store, state, 0)
        assert store.pv_reads == 0

    def test_read_setpoints_does_not_count_as_a_pv_read(self):
        # read_setpoints uses FC3 like a controller poll, but at the setpoint
        # window (HR 100+). Only the address range separates them.
        store, _ = fresh_store()
        sim.read_setpoints(store)
        assert store.pv_reads == 0, "internal setpoint read leaked into the PV counter"

    def test_read_coils_does_not_count(self):
        store, _ = fresh_store()
        sim.read_coils(store)
        assert (store.pv_reads, store.coil_writes) == (0, 0)

    def test_a_full_internal_tick_moves_neither_counter(self):
        # The combination is what matters: one whole simulated tick's worth of
        # internal access must be invisible to a controller-facing barrier.
        store, state = fresh_store()
        for _ in range(25):
            coils = sim.read_coils(store)
            setpoints = sim.read_setpoints(store)
            sim.update_water_tank(state, coils, setpoints, 1.0)
            sim.write_pvs(store, state, sim._build_status(state, coils))
        assert (store.pv_reads, store.coil_writes) == (0, 0)

    def test_external_pv_poll_is_counted(self):
        store, _ = fresh_store()
        store.getValues(3, 0, 5)          # what the OpenPLC master issues
        assert store.pv_reads == 1

    def test_external_input_register_poll_is_counted(self):
        store, _ = fresh_store()
        store.getValues(4, 0, 5)
        assert store.pv_reads == 1

    def test_external_coil_write_is_counted(self):
        store, _ = fresh_store()
        store.setValues(5, 0, [1])
        assert store.coil_writes == 1

    def test_external_multi_coil_write_is_counted(self):
        store, _ = fresh_store()
        store.setValues(15, 0, [1, 0, 1])
        assert store.coil_writes == 1

    def test_read_at_the_setpoint_window_is_not_a_pv_read(self):
        # Boundary: HR_PUMP_SPEED_SP is the first address that is NOT a PV.
        store, _ = fresh_store()
        store.getValues(3, sim.HR_PUMP_SPEED_SP, 1)
        assert store.pv_reads == 0

    def test_read_just_below_the_setpoint_window_is_a_pv_read(self):
        store, _ = fresh_store()
        store.getValues(3, sim.HR_PUMP_SPEED_SP - 1, 1)
        assert store.pv_reads == 1


# ── EpisodeClock ──────────────────────────────────────────────────────────────

class TestEpisodeClock:

    def test_starts_idle_and_owes_nothing(self):
        clock = sim.EpisodeClock()
        assert clock.tick == 0
        assert clock._drained.is_set()

    def test_request_returns_only_after_every_tick_is_consumed(self):
        async def scenario():
            clock = sim.EpisodeClock()
            consumed = []

            async def worker():
                for _ in range(5):
                    await clock.await_grant()
                    consumed.append(1)
                    clock.consume()

            task = asyncio.ensure_future(worker())
            await clock.request(5)
            # request() must not return early: all five are already consumed.
            assert len(consumed) == 5
            await task

        asyncio.run(scenario())

    def test_request_does_not_return_while_ticks_remain(self):
        async def scenario():
            clock = sim.EpisodeClock()

            async def slow_worker():
                for _ in range(3):
                    await clock.await_grant()
                    await asyncio.sleep(0.02)
                    clock.consume()

            asyncio.ensure_future(slow_worker())
            done = asyncio.ensure_future(clock.request(3))
            await asyncio.sleep(0.01)
            assert not done.done(), "request() returned before the ticks were computed"
            await done

        asyncio.run(scenario())

    def test_concurrent_steppers_conserve_ticks(self):
        # A lost or double-counted tick silently changes a trajectory, so this
        # checks the total rather than just that the calls returned.
        async def scenario():
            clock = sim.EpisodeClock()
            total = []

            async def worker():
                while True:
                    await clock.await_grant()
                    total.append(1)
                    clock.consume()
                    await asyncio.sleep(0)

            task = asyncio.ensure_future(worker())
            await asyncio.gather(clock.request(10), clock.request(10), clock.request(10))
            assert len(total) == 30
            task.cancel()

        asyncio.run(scenario())

    def test_await_grant_returns_immediately_when_ticks_are_owed(self):
        async def scenario():
            clock = sim.EpisodeClock()
            clock._budget = 1
            await asyncio.wait_for(clock.await_grant(), timeout=1.0)

        asyncio.run(scenario())

    def test_snapshot_survives_being_called_before_the_first_tick(self):
        snap = sim.EpisodeClock().snapshot()
        assert snap["tick"] == 0
        assert snap["state"] == {}
        assert snap["io"] == {"pv_reads": 0, "coil_writes": 0}


# ── settle barrier ────────────────────────────────────────────────────────────

class TestSettleBarrier:

    def test_reports_disabled_when_off(self, monkeypatch):
        monkeypatch.setattr(sim, "SIM_STEP_BARRIER", False)
        report = asyncio.run(sim._settle_barrier(sim.EpisodeClock()))
        assert report["mode"] == "disabled"
        assert report["satisfied"] is None

    def test_reports_unavailable_without_a_store(self, monkeypatch):
        monkeypatch.setattr(sim, "SIM_STEP_BARRIER", True)
        report = asyncio.run(sim._settle_barrier(sim.EpisodeClock()))
        assert report["mode"] == "unavailable"
        assert report["satisfied"] is False

    def test_times_out_on_the_read_phase_when_nothing_polls(self, monkeypatch):
        monkeypatch.setattr(sim, "SIM_STEP_BARRIER", True)
        monkeypatch.setattr(sim, "SIM_BARRIER_TIMEOUT_MS", 60)
        clock = sim.EpisodeClock()
        clock.store, _ = fresh_store()
        report = asyncio.run(sim._settle_barrier(clock))
        assert report["mode"] == "read"
        assert report["satisfied"] is False

    def test_times_out_on_the_write_phase_when_a_controller_reads_but_never_writes(self, monkeypatch):
        # A controller that only writes on change would land here. The barrier
        # must say so rather than report a settle that did not happen.
        monkeypatch.setattr(sim, "SIM_STEP_BARRIER", True)
        monkeypatch.setattr(sim, "SIM_BARRIER_TIMEOUT_MS", 120)
        clock = sim.EpisodeClock()
        clock.store, _ = fresh_store()

        async def scenario():
            async def read_only():
                await asyncio.sleep(0.01)
                clock.store.getValues(3, 0, 5)
            asyncio.ensure_future(read_only())
            return await sim._settle_barrier(clock)

        report = asyncio.run(scenario())
        assert report["mode"] == "write"
        assert report["satisfied"] is False

    def test_satisfied_on_a_full_read_then_write_scan(self, monkeypatch):
        monkeypatch.setattr(sim, "SIM_STEP_BARRIER", True)
        monkeypatch.setattr(sim, "SIM_BARRIER_TIMEOUT_MS", 2000)
        clock = sim.EpisodeClock()
        clock.store, _ = fresh_store()

        async def scenario():
            async def full_scan():
                await asyncio.sleep(0.01)
                clock.store.getValues(3, 0, 5)
                await asyncio.sleep(0.01)
                clock.store.setValues(5, 0, [1])
            asyncio.ensure_future(full_scan())
            return await sim._settle_barrier(clock)

        report = asyncio.run(scenario())
        assert report["mode"] == "scan"
        assert report["satisfied"] is True

    def test_a_write_already_in_flight_does_not_satisfy_the_barrier(self, monkeypatch):
        # The race the barrier exists to close: a coil write from a scan that ran
        # against the PREVIOUS state must not count. Only a write that follows a
        # fresh read does.
        monkeypatch.setattr(sim, "SIM_STEP_BARRIER", True)
        monkeypatch.setattr(sim, "SIM_BARRIER_TIMEOUT_MS", 80)
        clock = sim.EpisodeClock()
        clock.store, _ = fresh_store()
        clock.store.setValues(5, 0, [1])        # stale write, before the barrier

        async def scenario():
            async def read_only():
                await asyncio.sleep(0.01)
                clock.store.getValues(3, 0, 5)  # fresh read, but no write after it
            asyncio.ensure_future(read_only())
            return await sim._settle_barrier(clock)

        report = asyncio.run(scenario())
        assert report["satisfied"] is False, "stale write satisfied the barrier"
        assert report["mode"] == "write"


# ── HTTP framing and parsing ──────────────────────────────────────────────────

class TestHttpResponse:

    def test_framing_is_crlf_with_a_blank_line_before_the_body(self):
        raw = sim._http_response(200, {"a": 1})
        head, _, body = raw.partition(b"\r\n\r\n")
        assert raw.startswith(b"HTTP/1.1 200 OK\r\n")
        assert b"\n" not in head.replace(b"\r\n", b"")
        assert json.loads(body) == {"a": 1}

    def test_content_length_matches_the_body_exactly(self):
        raw = sim._http_response(200, {"msg": "a longer payload to size"})
        head, _, body = raw.partition(b"\r\n\r\n")
        declared = int(dict(
            line.split(": ", 1) for line in head.decode().split("\r\n")[1:]
        )["Content-Length"])
        assert declared == len(body)

    @pytest.mark.parametrize("code,reason", [
        (200, b"200 OK"), (400, b"400 Bad Request"),
        (404, b"404 Not Found"), (405, b"405 Method Not Allowed"),
    ])
    def test_reason_phrases(self, code, reason):
        assert sim._http_response(code, {}).startswith(b"HTTP/1.1 " + reason)

    def test_non_ascii_payload_is_length_counted_in_bytes_not_characters(self):
        # Content-Length is a byte count; a degree sign is two bytes in UTF-8.
        raw = sim._http_response(200, {"unit": "°C"})
        head, _, body = raw.partition(b"\r\n\r\n")
        assert b"Content-Length: %d" % len(body) in head


class TestReadRequest:

    def test_parses_a_bodyless_get(self):
        r = FakeReader(b"GET /state HTTP/1.1\r\nHost: x\r\n\r\n")
        assert asyncio.run(sim._read_request(r)) == ("GET", "/state", {})

    def test_parses_a_post_with_a_json_body(self):
        body = b'{"ticks": 7}'
        r = FakeReader(b"POST /step HTTP/1.1\r\nContent-Length: %d\r\n\r\n%s"
                       % (len(body), body))
        assert asyncio.run(sim._read_request(r)) == ("POST", "/step", {"ticks": 7})

    def test_content_length_header_is_case_insensitive(self):
        body = b'{"ticks": 2}'
        r = FakeReader(b"POST /step HTTP/1.1\r\ncOnTeNt-LeNgTh: %d\r\n\r\n%s"
                       % (len(body), body))
        assert asyncio.run(sim._read_request(r))[2] == {"ticks": 2}

    def test_malformed_json_yields_an_empty_body_not_an_exception(self):
        r = FakeReader(b"POST /step HTTP/1.1\r\nContent-Length: 3\r\n\r\n{;;")
        assert asyncio.run(sim._read_request(r))[2] == {}

    def test_a_json_array_is_rejected_as_a_body(self):
        # Only an object can carry "ticks"; a list must not reach .get().
        body = b'[1,2,3]'
        r = FakeReader(b"POST /step HTTP/1.1\r\nContent-Length: %d\r\n\r\n%s"
                       % (len(body), body))
        assert asyncio.run(sim._read_request(r))[2] == {}

    def test_empty_request_is_handled(self):
        assert asyncio.run(sim._read_request(FakeReader(b""))) == ("", "", {})

    def test_garbage_request_line_does_not_raise(self):
        r = FakeReader(b"nonsense\r\n\r\n")
        method, path, body = asyncio.run(sim._read_request(r))
        assert (method, path, body) == ("", "", {})


# ── physics determinism ───────────────────────────────────────────────────────

class TestDeterminism:

    @staticmethod
    def _trajectory(seed, ticks=40, pump=True):
        sim.RNG = random.Random(seed)
        state = sim.PhysicsState(volume_l=500.0, level_m=0.5, pressure_bar=0.05)
        coils = [pump, False, False, False, False, False]
        # Real setpoints, read from a real datastore: update_water_tank indexes
        # this dict directly, so an empty one is not a valid stand-in.
        store, _ = fresh_store()
        setpoints = sim.read_setpoints(store)
        rows = []
        for _ in range(ticks):
            sim.update_water_tank(state, coils, setpoints, 1.0)
            rows.append((state.level_m, state.flow_in_lpm,
                         state.flow_out_lpm, state.temperature_c))
        return rows

    def test_same_seed_reproduces_the_trajectory_exactly(self):
        assert self._trajectory(42) == self._trajectory(42)

    def test_a_different_seed_diverges(self):
        # The paired negative control. Without it, an identical result could mean
        # the comparison is insensitive rather than the simulation reproducible.
        assert self._trajectory(42) != self._trajectory(99)

    def test_the_trajectory_actually_moves(self):
        # Guards against the comparison passing because nothing happened. Uses a
        # real threshold: sensor noise alone shifts the level by ~1e-5.
        rows = self._trajectory(42)
        assert abs(rows[0][0] - rows[-1][0]) > 0.01

    def test_seeding_is_isolated_from_wall_clock_or_call_order(self):
        first = self._trajectory(7)
        self._trajectory(1234)          # unrelated run in between
        assert self._trajectory(7) == first


# ── small pure helpers ────────────────────────────────────────────────────────

class TestClamp:

    @pytest.mark.parametrize("value,expected", [
        (-1, 0), (0, 0), (500, 500), (65535, 65535), (70000, 65535),
    ])
    def test_clamps_to_the_uint16_register_range(self, value, expected):
        assert sim._clamp(value) == expected


class TestStatusWord:

    @staticmethod
    def _coils(pump=False, inlet=False, outlet=False, esd=False):
        return [pump, inlet, outlet, esd, False, False]

    def test_esd_is_reported(self):
        state = sim.PhysicsState(level_m=0.5)
        status = sim._build_status(state, self._coils(esd=True))
        assert status != 0

    def test_a_quiet_process_reports_no_flags(self):
        state = sim.PhysicsState(level_m=0.5, volume_l=500.0, pressure_bar=0.05)
        assert sim._build_status(state, self._coils()) == 0

    def test_running_pump_sets_a_flag(self):
        state = sim.PhysicsState(level_m=0.5, volume_l=500.0, pressure_bar=0.05)
        assert sim._build_status(state, self._coils(pump=True)) != 0
