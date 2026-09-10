#!/usr/bin/env python3
"""
sim.py — Physical process simulation server for ICS Simulator (Phase 11).

Runs a real-time physics model of an industrial process and exposes the state
as a Modbus TCP server. A PLC container reads sensor values (process variables)
as holding registers and writes control outputs as coils and setpoint registers
to influence the simulated process.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Modbus Register Map  (0-based addresses, unit = MODBUS_UNIT_ID)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Sensor Holding Registers — written by physics loop, read by PLC (FC3 / FC4):

  HR 0   LEVEL_PV        ×0.01 m       0–10000 → 0.00–100.00 m
  HR 1   FLOW_IN_PV      ×0.1 L/min    0–10000 → 0.0–1000.0 L/min
  HR 2   FLOW_OUT_PV     ×0.1 L/min    0–10000 → 0.0–1000.0 L/min
  HR 3   PRESSURE_PV     ×0.01 bar     0–10000 → 0.00–100.00 bar
  HR 4   TEMPERATURE_PV  ×0.1 °C       0–2000  → 0.0–200.0 °C
  HR 5   STATUS_WORD     bitmask       See STATUS_* constants below
  HR 6   FREQ_PV         ×0.01 Hz      generator only — clamped to GEN_FREQ_BASE ±3–5 Hz
  HR 7   VOLTAGE_PCT     ×0.01 %       0–12000 → 0.00–120.00 % of rated
  HR 8   POWER_PV        ×0.1 MW       0–10000 → 0.0–1000.0 MW
  HR 9   REACTIVE_PV     ×0.1 MVAR     0–10000 → 0.0–1000.0 MVAR

Setpoint Registers — written by PLC, read by physics loop (FC3 write / FC16):

  HR 100  PUMP_SPEED_SP   ×0.01 %      0–10000 → 0.00–100.00 %  (VFD speed)
  HR 101  INLET_VALVE_SP  ×0.01 %      0–10000 → 0.00–100.00 %  (valve opening)
  HR 102  LEVEL_SP        ×0.01 m      0–10000 → 0.00–100.00 m  (level setpoint)
  HR 103  LOAD_SP         ×0.1 MW      0–10000 → 0.0–1000.0 MW  (generator MW)

Control Coils — written by PLC digital outputs (FC1 / FC5 / FC15):

  CO 0   PUMP_CMD         0 = stop,  1 = run
  CO 1   INLET_VALVE_CMD  0 = close, 1 = open  (on/off command)
  CO 2   OUTLET_VALVE_CMD 0 = close, 1 = open  (gravity drain or bypass)
  CO 3   EMERGENCY_STOP   1 = ESD trip — immediately overrides all actuators
  CO 4   HEATER_CMD       0 = off,   1 = on   (batch-reactor only)
  CO 5   COOLING_CMD      0 = off,   1 = on   (batch-reactor only, cooling jacket)

STATUS_WORD bit mask (HR 5):
  bit 0  (0x0001): pump running
  bit 1  (0x0002): inlet valve open
  bit 2  (0x0004): outlet/drain valve open
  bit 3  (0x0008): emergency stop active
  bit 4  (0x0010): HIGH LEVEL alarm  (>85 % of TANK_VOLUME_L)
  bit 5  (0x0020): LOW LEVEL alarm   (<15 % of TANK_VOLUME_L)
  bit 6  (0x0040): HIGH PRESSURE alarm (>8.0 bar)
  bit 7  (0x0080): LOW FLOW alarm    (pump on, outlet flow < 5 L/min)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Supported Process Types  (PROCESS_TYPE environment variable)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  water-tank  — Liquid storage: inlet control valve + VFD pump + level/
                flow/pressure/temperature sensors. Classic water treatment
                or chemical reactor scenario.

  pipeline    — Pressurized pipeline: supply pump + isolation valve +
                pressure sensor. Uses simplified bulk-modulus hydraulic
                model to show pressure transients.

  generator   — Synchronous electrical generator: frequency and voltage
                dynamics from the IEEE swing equation. Models governor
                and AVR response. Suitable for power-grid attack scenarios.

  generic     — Multi-frequency signal generator: four sine/ramp waves on
                HR 0–3. Useful for protocol scanner labs when a specific
                process model is not needed.

  batch-reactor — ISA-88 batch vessel: charge valve (CO 1) fills the vessel
                (reuses INLET_VALVE_CMD/VALVE_FLOW_MAX_LPM), agitator (CO 0,
                reuses PUMP_CMD) improves mixing only, heater (CO 4) and
                cooling jacket (CO 5) drive temperature, discharge valve
                (CO 2, reuses OUTLET_VALVE_CMD/gravity-drain model) empties
                the vessel. Paired with a batch-controller device running
                buildBatchProgram()'s S88 phase-sequencer ST — see
                packages/orchestrator/src/plc-program-gen.ts.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Educational purpose
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Students write IEC 61131-3 Structured Text on the OpenPLC Runtime container:

  1. Read HR 0 (LEVEL_PV) → convert to engineering units (÷100 = m).
  2. Compare to LEVEL_SP (HR 102).
  3. Write CO 0 (PUMP_CMD) and HR 100 (PUMP_SPEED_SP) to control level.
  4. Monitor HR 5 (STATUS_WORD) bits for alarms and implement interlocks.

An attacker replaying Modbus writes can:
  - Simultaneously assert PUMP_CMD=1 and INLET_VALVE_CMD=1 at max speed
    → tank overflow (high-level alarm, physical damage scenario)
  - Write EMERGENCY_STOP=1 → immediate process shutdown (denial of service)
  - Spoof PUMP_SPEED_SP=0 while pump coil=1 → low-flow alarm, cavitation

References:
  ISA-5.1-2009 — Instrumentation Symbols and Identification
  ISA-88        — Batch Control Models (process unit concept)
  IEC 61511-1  — Safety Instrumented Systems for the process industry
  IEEE Std 421.5-2016 — Generator Excitation System Models
  Torricelli's theorem — Q = Cd × A_orifice × √(2gh)  [drain model]
  Modbus Application Protocol Specification v1.1b3
  pymodbus 3.7 documentation: https://pymodbus.readthedocs.io
"""

import asyncio
import logging
import math
import os
import random
from dataclasses import dataclass, field as dc_field

from pymodbus.datastore import (
    ModbusSequentialDataBlock,
    ModbusServerContext,
    ModbusSlaveContext,
)
from pymodbus.server import StartAsyncTcpServer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ics-process-sim")

# ── Configuration  (injected by Docker Compose via environment variables) ─────
DEVICE_ID    = os.getenv("DEVICE_ID",    "process-1")
PROCESS_TYPE = os.getenv("PROCESS_TYPE", "water-tank")
MODBUS_PORT  = int(os.getenv("MODBUS_PORT",    "502"))
UNIT_ID      = int(os.getenv("MODBUS_UNIT_ID", "1"))
# Physics timestep: 1000 ms matches typical SCADA polling rates.
# Reduce to 200 ms for faster transient response in lab exercises.
SIM_DT_MS    = int(os.getenv("SIM_DT_MS", "1000"))

# ── Determinism  (evaluation-harness support) ─────────────────────────────────
# The physics models below add pseudo-random instrument noise to their sensor
# outputs. For classroom use a fresh noise stream every run is desirable — no
# two lab sessions look identical. Automated evaluation needs the opposite
# guarantee: an identical sequence of control actions must produce an identical
# process trajectory on every machine, or scores cannot be compared or replayed.
#
# SIM_SEED pins that stream. When it is unset we still draw a seed and log it,
# so a run can be replayed afterwards by passing the logged value back in —
# there is no such thing here as an unreproducible run.
#
# The stream is a private random.Random instance rather than the module-level
# random.* functions on purpose. The global RNG is shared with every library in
# the process (pymodbus, asyncio helpers, anything imported later), so an
# unrelated dependency drawing from it would silently shift our noise sequence.
# A private instance depends only on SIM_SEED and on our own call order.
_SEED_ENV = os.getenv("SIM_SEED")
SIM_SEED  = (int(_SEED_ENV) if _SEED_ENV not in (None, "")
             else random.SystemRandom().getrandbits(63))
RNG       = random.Random(SIM_SEED)

# Water tank parameters
TANK_VOLUME_L      = float(os.getenv("TANK_VOLUME_L",      "1000.0"))  # capacity, liters
TANK_AREA_M2       = float(os.getenv("TANK_AREA_M2",       "1.0"))     # cross-section, m²
PUMP_FLOW_MAX_LPM  = float(os.getenv("PUMP_FLOW_MAX_LPM",  "150.0"))   # outlet pump max, L/min
VALVE_FLOW_MAX_LPM = float(os.getenv("VALVE_FLOW_MAX_LPM", "200.0"))   # inlet max flow, L/min
INITIAL_LEVEL_PCT  = float(os.getenv("INITIAL_LEVEL_PCT",  "50.0"))    # starting fill, %

# Generator parameters
GEN_RATED_MW  = float(os.getenv("GENERATOR_RATED_MW",  "100.0"))  # rated active power, MW
GEN_INERTIA_H = float(os.getenv("GENERATOR_INERTIA_H", "6.0"))    # inertia constant, s
GEN_FREQ_BASE = float(os.getenv("GENERATOR_FREQ_BASE", "50.0"))   # nominal frequency, Hz

# Pipeline parameters
PIPELINE_VOLUME_L = float(os.getenv("PIPELINE_VOLUME_L",     "500.0"))  # pipe volume, liters
PIPELINE_PUMP_MAX = float(os.getenv("PIPELINE_PUMP_MAX_LPM", "300.0"))  # pump max flow, L/min

# Batch reactor parameters — vessel geometry/flow reuse TANK_VOLUME_L/TANK_AREA_M2/
# PUMP_FLOW_MAX_LPM (agitator)/VALVE_FLOW_MAX_LPM (charge) above; only heat/cool
# rates are new, since water-tank has no driven heater/cooling jacket.
HEATER_RATE_C_PER_S  = float(os.getenv("HEATER_RATE_C_PER_S",  "0.05"))  # °C/s while CO_HEATER_CMD=1
COOLING_RATE_C_PER_S = float(os.getenv("COOLING_RATE_C_PER_S", "0.08"))  # °C/s while CO_COOLING_CMD=1
# Effective bulk modulus for bulk-modulus pressure model (accounts for pipe elasticity).
# Pure water: ~2.2 GPa; effective with mild-steel pipe compliance: ~1.0 GPa → use 1e9 Pa.
# Scaled down here to 1e6 for a slow, educationally observable response over seconds.
PIPELINE_BULK_MOD = 1.0e6  # effective bulk modulus, Pa

# ── Modbus register addresses (0-based) ───────────────────────────────────────
# Sensor process variables — physics loop writes, PLC reads
HR_LEVEL_PV       = 0   # ×0.01 m
HR_FLOW_IN_PV     = 1   # ×0.1 L/min
HR_FLOW_OUT_PV    = 2   # ×0.1 L/min
HR_PRESSURE_PV    = 3   # ×0.01 bar
HR_TEMPERATURE_PV = 4   # ×0.1 °C
HR_STATUS_WORD    = 5   # bitmask (see STATUS_* below)
HR_FREQ_PV        = 6   # ×0.01 Hz
HR_VOLTAGE_PCT    = 7   # ×0.01 %
HR_POWER_PV       = 8   # ×0.1 MW
HR_REACTIVE_PV    = 9   # ×0.1 MVAR

# Setpoint registers — PLC writes, physics loop reads
HR_PUMP_SPEED_SP  = 100  # ×0.01 %   (0–10000 = 0.00–100.00 %)
HR_INLET_VALVE_SP = 101  # ×0.01 %
HR_LEVEL_SP       = 102  # ×0.01 m   (level controller setpoint)
HR_LOAD_SP        = 103  # ×0.1  MW  (generator load setpoint)

# Coil addresses — PLC writes as digital control outputs (FC1)
CO_PUMP_CMD         = 0  # 0 = stop,  1 = run                 (batch-reactor: agitator)
CO_INLET_VALVE_CMD  = 1  # 0 = close, 1 = open                (batch-reactor: charge valve)
CO_OUTLET_VALVE_CMD = 2  # 0 = close, 1 = open (gravity drain / bypass) (batch-reactor: discharge valve)
CO_EMERGENCY_STOP   = 3  # 1 = ESD trip — overrides all actuators immediately
CO_HEATER_CMD       = 4  # 0 = off, 1 = on  (batch-reactor only)
CO_COOLING_CMD      = 5  # 0 = off, 1 = on  (batch-reactor only, cooling jacket)

# STATUS_WORD bitmasks (HR_STATUS_WORD, HR 5)
STATUS_PUMP_RUN   = 0x0001  # pump motor running
STATUS_INLET_OPEN = 0x0002  # inlet valve energised open
STATUS_OUTLET_OPEN = 0x0004  # outlet/drain valve energised open
STATUS_ESD        = 0x0008  # emergency stop latch active
STATUS_HI_LEVEL   = 0x0010  # fill > 85 % of TANK_VOLUME_L — overflow risk
STATUS_LO_LEVEL   = 0x0020  # fill < 15 % of TANK_VOLUME_L — dry-run risk
STATUS_HI_PRESS   = 0x0040  # pressure > 8.0 bar — over-pressure alarm
STATUS_LO_FLOW    = 0x0080  # pump running but outlet flow < 5 L/min — blockage


@dataclass
class PhysicsState:
    """
    Mutable snapshot of all process variables updated every simulation tick.

    All values are stored in SI / engineering units. The write_pvs() function
    converts them to scaled uint16 Modbus register values before writing.

    Fields set by physics functions:
      level_m       — tank fill level (m)  or equivalent for other processes
      flow_in_lpm   — inlet flow (L/min)
      flow_out_lpm  — outlet flow (L/min)
      pressure_bar  — process pressure (bar)
      temperature_c — process temperature (°C)
      freq_hz       — electrical frequency (Hz)  [generator only]
      voltage_pct   — terminal voltage as % of rated  [generator only]
      power_mw      — active power output (MW)  [generator only]
      reactive_mvar — reactive power (MVAR)  [generator only]

    Internal integration variables:
      volume_l      — liquid volume for water-tank integration (liters)
      sim_time_s    — elapsed simulation time in seconds (for periodic signals)
    """
    # Process variable outputs (written to Modbus registers each tick)
    level_m:        float = 0.0
    flow_in_lpm:    float = 0.0
    flow_out_lpm:   float = 0.0
    pressure_bar:   float = 0.0
    temperature_c:  float = 20.0
    freq_hz:        float = 50.0
    voltage_pct:    float = 100.0
    power_mw:       float = 0.0
    reactive_mvar:  float = 0.0

    # Internal integration state
    volume_l:       float = dc_field(default=0.0)  # water-tank: fill volume, L
    sim_time_s:     float = dc_field(default=0.0)  # monotonic simulation clock


# ── Modbus datastore helpers ───────────────────────────────────────────────────

def build_store(state: PhysicsState) -> ModbusSlaveContext:
    """
    Creates the pymodbus slave context (register datastore) with initial values.

    Allocates 256-register blocks for HR, IR, and coils. Input registers (IR)
    mirror HR so both FC3 and FC4 reads return consistent sensor values.

    Args:
        state: Initial PhysicsState used to pre-populate sensor registers.

    Returns:
        ModbusSlaveContext ready for use in a ModbusServerContext.
    """
    hr = [0] * 256

    # Pre-populate initial sensor values so the PLC sees valid readings
    # before the first physics tick arrives
    hr[HR_LEVEL_PV]       = _clamp(int(state.level_m * 100))
    hr[HR_FLOW_IN_PV]     = 0
    hr[HR_FLOW_OUT_PV]    = 0
    hr[HR_PRESSURE_PV]    = _clamp(int(state.pressure_bar * 100))
    hr[HR_TEMPERATURE_PV] = _clamp(int(state.temperature_c * 10))
    hr[HR_FREQ_PV]        = _clamp(int(state.freq_hz * 100))
    hr[HR_VOLTAGE_PCT]    = _clamp(int(state.voltage_pct * 100))

    # Default setpoints: 50% pump speed, 50% valve opening, level SP = initial level
    hr[HR_PUMP_SPEED_SP]  = 5000   # 50.00 %
    hr[HR_INLET_VALVE_SP] = 5000   # 50.00 %
    hr[HR_LEVEL_SP]       = _clamp(int(state.level_m * 100))

    return ModbusSlaveContext(
        di=ModbusSequentialDataBlock(0, [0] * 256),  # discrete inputs — unused
        co=ModbusSequentialDataBlock(0, [0] * 256),  # coils — PLC writes control
        hr=ModbusSequentialDataBlock(0, list(hr)),   # holding registers
        ir=ModbusSequentialDataBlock(0, list(hr)),   # input registers mirror HR
    )


def read_coils(store: ModbusSlaveContext) -> list[bool]:
    """
    Reads the six control coils (FC1) from the Modbus datastore.

    Returns a list indexed by coil address:
      [0] PUMP_CMD, [1] INLET_VALVE_CMD, [2] OUTLET_VALVE_CMD, [3] EMERGENCY_STOP,
      [4] HEATER_CMD (batch-reactor only), [5] COOLING_CMD (batch-reactor only)

    water-tank/pipeline/generator physics functions only index [0:4] and
    simply ignore the two extra batch-reactor coils.
    """
    # getValues(function_code=1, address=0, count=6) — FC1 = coils
    raw = store.getValues(1, 0, 6)
    return [bool(v) for v in raw]


def read_setpoints(store: ModbusSlaveContext) -> dict[int, int]:
    """
    Reads setpoint holding registers HR 100–103 (FC3).

    Returns {HR_address: raw_value} where raw values use ×0.01 % / ×0.01 m / ×0.1 MW
    scaling as defined in the register map.
    """
    raw = store.getValues(3, HR_PUMP_SPEED_SP, 4)  # FC3, 4 consecutive registers
    return {
        HR_PUMP_SPEED_SP:  raw[0],  # 0–10000 = 0.00–100.00 %
        HR_INLET_VALVE_SP: raw[1],  # 0–10000 = 0.00–100.00 %
        HR_LEVEL_SP:       raw[2],  # 0–10000 = 0.00–100.00 m
        HR_LOAD_SP:        raw[3],  # 0–10000 = 0.0–1000.0 MW
    }


def write_pvs(store: ModbusSlaveContext, state: PhysicsState, status: int) -> None:
    """
    Converts engineering-unit values from PhysicsState to scaled uint16 integers
    and writes them to both HR (FC3) and IR (FC4) so either function code works.

    Scaling:
      LEVEL_PV       × 100  → uint16  (0.01 m resolution)
      FLOW_*_PV      × 10   → uint16  (0.1 L/min resolution)
      PRESSURE_PV    × 100  → uint16  (0.01 bar resolution)
      TEMPERATURE_PV × 10   → uint16  (0.1 °C resolution)
      FREQ_PV        × 100  → uint16  (0.01 Hz resolution)
      VOLTAGE_PCT    × 100  → uint16  (0.01 % resolution)
      POWER_PV       × 10   → uint16  (0.1 MW resolution)
      REACTIVE_PV    × 10   → uint16  (0.1 MVAR resolution)
    """
    pvs: dict[int, int] = {
        HR_LEVEL_PV:       _clamp(int(state.level_m * 100)),
        HR_FLOW_IN_PV:     _clamp(int(state.flow_in_lpm * 10)),
        HR_FLOW_OUT_PV:    _clamp(int(state.flow_out_lpm * 10)),
        HR_PRESSURE_PV:    _clamp(int(state.pressure_bar * 100)),
        HR_TEMPERATURE_PV: _clamp(int(state.temperature_c * 10)),
        HR_STATUS_WORD:    status,
        HR_FREQ_PV:        _clamp(int(state.freq_hz * 100)),
        HR_VOLTAGE_PCT:    _clamp(int(state.voltage_pct * 100)),
        HR_POWER_PV:       _clamp(int(state.power_mw * 10)),
        HR_REACTIVE_PV:    _clamp(int(state.reactive_mvar * 10)),
    }
    for addr, val in pvs.items():
        store.setValues(3, addr, [val])  # HR (FC3)
        store.setValues(4, addr, [val])  # IR (FC4) kept in sync


def _clamp(v: int, lo: int = 0, hi: int = 65535) -> int:
    """Clamp an integer to valid Modbus uint16 range [lo, hi]."""
    return max(lo, min(hi, v))


def _build_status(state: PhysicsState, coils: list[bool]) -> int:
    """
    Computes the STATUS_WORD bitmask from current state and coil commands.

    Alarm logic:
      HIGH LEVEL  — fill > 85 % of TANK_VOLUME_L (overflow imminent)
      LOW LEVEL   — fill < 15 % of TANK_VOLUME_L (pump cavitation risk)
      HIGH PRESS  — pressure > 8.0 bar (pipeline/vessel over-pressure)
      LOW FLOW    — pump commanded on but outlet flow < 5 L/min
                    (possible blockage, closed discharge valve, or dry run)

    These thresholds are intentionally conservative so students see alarms
    during normal lab exercises, not only during adversarial scenarios.
    """
    esd      = coils[CO_EMERGENCY_STOP]
    pump_run = coils[CO_PUMP_CMD]   and not esd
    inlet    = coils[CO_INLET_VALVE_CMD]  and not esd
    outlet   = coils[CO_OUTLET_VALVE_CMD]

    max_vol  = TANK_VOLUME_L
    hi_level = state.volume_l > max_vol * 0.85
    lo_level = state.volume_l < max_vol * 0.15
    hi_press = state.pressure_bar > 8.0
    lo_flow  = pump_run and state.flow_out_lpm < 5.0

    word = 0
    if pump_run:   word |= STATUS_PUMP_RUN
    if inlet:      word |= STATUS_INLET_OPEN
    if outlet:     word |= STATUS_OUTLET_OPEN
    if esd:        word |= STATUS_ESD
    if hi_level:   word |= STATUS_HI_LEVEL
    if lo_level:   word |= STATUS_LO_LEVEL
    if hi_press:   word |= STATUS_HI_PRESS
    if lo_flow:    word |= STATUS_LO_FLOW
    return word


# ── Process physics models ─────────────────────────────────────────────────────

def update_water_tank(state: PhysicsState, coils: list[bool],
                      setpoints: dict[int, int], dt: float) -> None:
    """
    Water tank level dynamics using a first-order volume balance.

    Volume balance (Euler integration, timestep dt seconds):
      dV/dt = Q_in − Q_out   [L/s]

      Q_in = inlet_valve_sp × VALVE_FLOW_MAX_LPM ÷ 60   when INLET_VALVE_CMD = 1
      Q_out = pump_speed_sp × PUMP_FLOW_MAX_LPM ÷ 60    when PUMP_CMD = 1
      Q_drain (gravity) = K_drain × √level_m             when OUTLET_VALVE_CMD = 1
                          (Torricelli-derived: K_drain empirically tuned for
                           a 50% full tank to drain in ~30 minutes)

    Level and hydrostatic pressure:
      level_m = volume_l / (TANK_AREA_M2 × 1000)
      P_bar   = level_m × ρ × g / 1e5
              = level_m × 9810 / 1e5 = level_m × 0.0981  [bar]

    Temperature (Newton cooling model):
      dT/dt = pump_speed × 0.15 °C/s (friction heat)
            − (T − T_ambient) × 0.02 s⁻¹ (convective cooling)

    Gaussian measurement noise (σ = 0.1 % of full scale) added to all flows
    to simulate instrument uncertainty — real SCADA values are never perfectly
    stable at a fixed reading.

    ESD logic: CO_EMERGENCY_STOP = 1 forces PUMP_CMD and INLET_VALVE_CMD off,
    simulating a safety instrumented function (SIF) trip via a dedicated SIS.

    Args:
        state:     PhysicsState modified in-place.
        coils:     Control coils read from Modbus datastore.
        setpoints: Setpoint registers read from Modbus datastore.
        dt:        Elapsed time in seconds per physics step.
    """
    esd = coils[CO_EMERGENCY_STOP]

    pump_cmd    = coils[CO_PUMP_CMD]          and not esd
    inlet_cmd   = coils[CO_INLET_VALVE_CMD]   and not esd
    outlet_cmd  = coils[CO_OUTLET_VALVE_CMD]  # bypass valve not tripped by ESD

    # Setpoints: raw ÷ 10000 = fractional 0–1 (10000 raw = 100.00 %)
    pump_frac  = setpoints[HR_PUMP_SPEED_SP]  / 10000.0
    inlet_frac = setpoints[HR_INLET_VALVE_SP] / 10000.0

    # ── Inlet flow: valve position × max rated flow ──────────────────────────
    q_in = inlet_frac * VALVE_FLOW_MAX_LPM if inlet_cmd else 0.0
    q_in = max(0.0, q_in + RNG.gauss(0.0, VALVE_FLOW_MAX_LPM * 0.001))

    # ── Outlet flow: VFD-controlled pump ─────────────────────────────────────
    q_out_pump = pump_frac * PUMP_FLOW_MAX_LPM if pump_cmd else 0.0
    q_out_pump = max(0.0, q_out_pump + RNG.gauss(0.0, PUMP_FLOW_MAX_LPM * 0.001))

    # ── Gravity drain via bypass outlet valve (Torricelli model) ─────────────
    level_m = state.volume_l / (TANK_AREA_M2 * 1000.0)
    if outlet_cmd and not pump_cmd and level_m > 0.001:
        # K_drain = 15 L/min per √m — empirically gives ~30-min drain from 50%
        q_out_drain = 15.0 * math.sqrt(level_m)
    else:
        q_out_drain = 0.0

    q_out = q_out_pump + q_out_drain

    # ── Volume integration: dV = (Q_in − Q_out) [L/s] × dt ──────────────────
    dV = (q_in - q_out) / 60.0 * dt  # convert L/min → L/s, then ×dt
    state.volume_l = max(0.0, min(TANK_VOLUME_L, state.volume_l + dV))

    # ── Update all state outputs for write_pvs() ─────────────────────────────
    level_m = state.volume_l / (TANK_AREA_M2 * 1000.0)
    state.level_m      = level_m
    state.flow_in_lpm  = max(0.0, q_in)
    state.flow_out_lpm = max(0.0, q_out)
    state.pressure_bar = level_m * 0.0981  # hydrostatic: P = ρgh / 1e5

    # ── Temperature dynamics ──────────────────────────────────────────────────
    T_ambient   = 20.0  # °C
    pump_heat   = pump_frac * 0.15          # max 0.15 °C/s at full speed
    newton_cool = (state.temperature_c - T_ambient) * 0.02  # decay to ambient
    dT = (pump_heat - newton_cool) * dt
    state.temperature_c = max(T_ambient - 2.0, min(90.0, state.temperature_c + dT))


def update_batch_reactor(state: PhysicsState, coils: list[bool], dt: float) -> None:
    """
    ISA-88 batch vessel physics: charge/discharge volume + heat/cool temperature,
    both first-order integrations reusing exactly the patterns already proven in
    update_water_tank() above — the vessel is physically the same shape as a
    water tank, only its equipment set (heater/cooling jacket instead of a
    variable-speed outlet pump) differs.

    No setpoint registers are read here — unlike water-tank's fractional
    HR_PUMP_SPEED_SP/HR_INLET_VALVE_SP, batch-reactor valves/heater/cooling
    are simple on/off equipment. The batch-controller's ST program (see
    buildBatchProgram() in plc-program-gen.ts) decides WHEN to energize each
    coil based on its own phase logic and the PVs read back from here — this
    function only integrates the physical response, same separation of
    concerns as every other process type.

    Volume balance (charge valve fills, discharge valve actively pumps out):
      dV/dt = Q_charge − Q_discharge   [L/s]
      Q_charge    = VALVE_FLOW_MAX_LPM   when CO_INLET_VALVE_CMD (charge) = 1
      Q_discharge = VALVE_FLOW_MAX_LPM   when CO_OUTLET_VALVE_CMD (discharge) = 1
                    A real batch reactor discharges via an actively pumped
                    line, not passive gravity drain — unlike update_water_tank's
                    bypass-outlet case, so this deliberately does NOT reuse the
                    Torricelli √level model (which asymptotically slows near
                    empty and would leave DISCHARGE unable to complete in any
                    practical recipe hold time).

    Temperature (driven heat/cool vs. Newton cooling to ambient):
      dT/dt = heater_on × HEATER_RATE_C_PER_S × (1.15 if agitator_on else 1.0)
            − cooling_on × COOLING_RATE_C_PER_S
            − (T − T_ambient) × 0.02 s⁻¹
      The small agitator boost is a minor realism touch (better mixing → better
      heat transfer) — the agitator has no effect on volume/level.

    ESD (CO_EMERGENCY_STOP): forces the charge valve and heater off and forces
    the cooling jacket on (drive toward a safe, cool, non-reacting state) —
    same "stop inputs, don't touch outputs" philosophy as update_water_tank's
    ESD handling. Discharge valve and agitator are NOT tripped by ESD, mirroring
    update_water_tank's bypass-outlet-not-tripped precedent.

    Args:
        state: PhysicsState modified in-place.
        coils: Control coils — [0] agitator, [1] charge valve, [2] discharge
               valve, [3] ESD, [4] heater, [5] cooling jacket.
        dt:    Elapsed time in seconds per physics step.
    """
    esd = coils[CO_EMERGENCY_STOP]

    agitator_on  = coils[CO_PUMP_CMD]
    charge_on    = coils[CO_INLET_VALVE_CMD]  and not esd
    discharge_on = coils[CO_OUTLET_VALVE_CMD]  # not tripped by ESD
    heater_on    = coils[CO_HEATER_CMD]        and not esd
    cooling_on   = coils[CO_COOLING_CMD] or esd  # ESD forces cooling on

    # ── Volume integration ────────────────────────────────────────────────────
    level_m = state.volume_l / (TANK_AREA_M2 * 1000.0)
    q_charge = VALVE_FLOW_MAX_LPM if charge_on else 0.0
    q_discharge = VALVE_FLOW_MAX_LPM if discharge_on else 0.0

    dV = (q_charge - q_discharge) / 60.0 * dt  # L/min → L/s, then × dt
    state.volume_l = max(0.0, min(TANK_VOLUME_L, state.volume_l + dV))

    level_m = state.volume_l / (TANK_AREA_M2 * 1000.0)
    state.level_m       = level_m
    state.flow_in_lpm   = q_charge if charge_on else 0.0
    state.flow_out_lpm  = q_discharge
    state.pressure_bar  = level_m * 0.0981  # hydrostatic, same as update_water_tank

    # ── Temperature dynamics ──────────────────────────────────────────────────
    T_ambient = 20.0  # °C
    agitator_boost = 1.15 if agitator_on else 1.0
    heat_in  = (HEATER_RATE_C_PER_S * agitator_boost) if heater_on else 0.0
    cool_out = COOLING_RATE_C_PER_S if cooling_on else 0.0
    newton_cool = (state.temperature_c - T_ambient) * 0.02
    dT = (heat_in - cool_out - newton_cool) * dt
    state.temperature_c = max(15.0, min(150.0, state.temperature_c + dT))


def update_pipeline(state: PhysicsState, coils: list[bool],
                    setpoints: dict[int, int], dt: float) -> None:
    """
    Pipeline pressure dynamics using a simplified bulk-modulus hydraulic model.

    Pressure dynamics:
      dP/dt = (Q_in − Q_out) × B_eff / V_pipe   [Pa/s]

      where B_eff = PIPELINE_BULK_MOD (effective bulk modulus, Pa)
            V_pipe = PIPELINE_VOLUME_L / 1000  (m³)

      Q_in  = pump flow (m³/s) when pump commanded on
      Q_out = load/consumption flow: proportional to √P (orifice equation)
              Q = C_v × √P_pa   where C_v is tuned to give ~5 bar at 50% pump
              With OUTLET_VALVE_CMD = 1: full isolation valve open → large Q_out
              simulating a line break or full-open consumer demand

    The bulk modulus model produces pressure transients that are observable at
    1 Hz polling intervals, making it suitable for SCADA lab exercises.

    Level register (HR 0) reports pipeline fill % mapped to 0–100 m scale
    so FUXA / Grafana can display a meaningful bar graph without special scaling.

    Args:
        state:     PhysicsState modified in-place.
        coils:     Control coils.
        setpoints: Setpoint registers.
        dt:        Timestep in seconds.
    """
    esd = coils[CO_EMERGENCY_STOP]
    pump_cmd   = coils[CO_PUMP_CMD]   and not esd
    outlet_cmd = coils[CO_OUTLET_VALVE_CMD]

    pump_frac = setpoints[HR_PUMP_SPEED_SP] / 10000.0

    # ── Pump inflow (m³/s) ────────────────────────────────────────────────────
    q_in_lpm = pump_frac * PIPELINE_PUMP_MAX if pump_cmd else 0.0
    q_in_m3s = q_in_lpm / 60000.0  # L/min → m³/s

    # ── Consumption outflow: orifice model — proportional to √P ──────────────
    P_pa = max(0.0, state.pressure_bar * 1e5)
    # Cv tuned so pump at 50% speed → 5 bar equilibrium at baseline demand
    Cv_base = 1.2e-4  # m³/s per √Pa (open outlet valve triples this)
    Cv = Cv_base * (3.0 if outlet_cmd else 1.0)
    q_out_m3s = Cv * math.sqrt(P_pa)

    # ── Pressure integration ──────────────────────────────────────────────────
    V_pipe_m3 = PIPELINE_VOLUME_L / 1000.0
    dP_pa = (q_in_m3s - q_out_m3s) * PIPELINE_BULK_MOD / V_pipe_m3 * dt
    P_new_bar = max(0.0, min(200.0, state.pressure_bar + dP_pa / 1e5))
    state.pressure_bar = P_new_bar

    # ── Update outputs ────────────────────────────────────────────────────────
    state.level_m      = (P_new_bar / 10.0) * 10.0  # map 0–10 bar → 0–10 m for display
    state.flow_in_lpm  = q_in_lpm
    state.flow_out_lpm = q_out_m3s * 60000.0        # m³/s → L/min
    # Volume for alarm thresholds: map pressure to fill fraction
    state.volume_l     = (P_new_bar / 10.0) * TANK_VOLUME_L

    # Compression heat
    state.temperature_c += (P_new_bar * 0.001 - 0.01) * dt
    state.temperature_c  = max(10.0, min(80.0, state.temperature_c))


def update_generator(state: PhysicsState, coils: list[bool],
                     setpoints: dict[int, int], dt: float) -> None:
    """
    Simplified synchronous generator dynamics using the IEEE swing equation.

    Frequency dynamics:
      df/dt = (P_mech − P_load) / (2 × H × f_s)   [Hz/s]

      where H   = GEN_INERTIA_H (inertia constant, seconds)
            f_s = GEN_FREQ_BASE (synchronous frequency, Hz)

    P_mech is the governor-controlled mechanical power (prime mover output):
      - Commanded via HR_LOAD_SP (first-order lag τ = 5 s to governor setpoint)
      - Defaults to 50 % rated if HR_LOAD_SP = 0

    P_load is the aggregate electrical demand:
      - Slow random walk simulating variable consumer load
      - Remains constant when breaker is open

    Automatic Voltage Regulator (AVR) — simplified droop model:
      V_pu = 1.0 − 0.05 × (P_load / P_rated)   (lagging power factor effect)
      Terminal voltage tracks this with 0.2 s⁻¹ AVR gain.

    CO_PUMP_CMD is re-used as the generator circuit breaker:
      CO 0 = 0: generator off-line (open breaker)
      CO 0 = 1: generator on-line (closed breaker, exporting power)

    CO_EMERGENCY_STOP trips the generator immediately (inter-trip relay).

    Args:
        state:     PhysicsState modified in-place.
        coils:     Control coils.
        setpoints: Setpoint registers.
        dt:        Timestep in seconds.
    """
    breaker_closed = coils[CO_PUMP_CMD] and not coils[CO_EMERGENCY_STOP]

    # Mechanical power setpoint from governor (raw ×0.1 MW)
    load_sp_raw = setpoints[HR_LOAD_SP]
    p_mech_sp = (load_sp_raw / 10.0) if load_sp_raw > 0 else (GEN_RATED_MW * 0.5)

    if not breaker_closed:
        # Off-line: coast to synchronous speed, voltage holds at rated.
        # Clamp is relative to GEN_FREQ_BASE (not hardcoded 45-55) — a
        # hardcoded absolute clamp below the default 60 Hz nominal made it
        # mathematically impossible for an off-line generator to ever
        # actually reach synchronous speed (df→0 as freq_hz→GEN_FREQ_BASE,
        # but the old ceiling of 55.0 clamped it away from 60.0 on literally
        # the first tick) — the exact opposite of what this branch's own
        # comment says it does. Found live-verifying containers/pmu, which
        # was the first device to closely observe an off-line generator's
        # frequency at startup.
        df = (GEN_FREQ_BASE - state.freq_hz) * 0.3 * dt
        state.freq_hz   = max(GEN_FREQ_BASE - 5.0, min(GEN_FREQ_BASE + 5.0, state.freq_hz + df))
        state.power_mw  = 0.0
        state.reactive_mvar = 0.0
        state.voltage_pct   = 100.0
        # Carry no load in volume for alarm purposes
        state.volume_l  = 0.0
        state.level_m   = 0.0
        return

    # ── Governor response: first-order lag, τ = 5 s ───────────────────────────
    # Mechanical power tracks setpoint with realistic governor lag
    p_err = p_mech_sp - state.power_mw
    state.power_mw += (p_err / 5.0) * dt
    state.power_mw  = max(0.0, min(GEN_RATED_MW * 1.1, state.power_mw))

    # ── Load disturbance: random walk simulating consumer demand ─────────────
    demand_noise = RNG.gauss(0.0, GEN_RATED_MW * 0.003)
    p_load = state.power_mw + demand_noise

    # ── Swing equation: frequency deviation ──────────────────────────────────
    # Clamp is relative to GEN_FREQ_BASE (±3 Hz), not hardcoded 47-53 — that
    # hardcoded band was only ever centered on the default 50 Hz case (see
    # the matching fix + comment on the off-line branch above); any scenario
    # configuring GEN_FREQ_BASE=60 (the common US-convention case) got an
    # operating band that excluded its own nominal frequency entirely.
    df_dt = (p_mech_sp - p_load) / (2.0 * GEN_INERTIA_H * GEN_FREQ_BASE)
    state.freq_hz = max(GEN_FREQ_BASE - 3.0, min(GEN_FREQ_BASE + 3.0, state.freq_hz + df_dt * dt))

    # ── AVR: voltage droop ────────────────────────────────────────────────────
    v_target = (1.0 - 0.05 * (state.power_mw / GEN_RATED_MW)) * 100.0
    v_err = v_target - state.voltage_pct
    state.voltage_pct += v_err * 0.2 * dt
    state.voltage_pct  = max(80.0, min(115.0, state.voltage_pct))

    # Reactive power: proportional to voltage deviation (simplified Q-V droop)
    state.reactive_mvar = (state.voltage_pct - 100.0) * GEN_RATED_MW * 0.01

    # Map loading to level/volume for display and alarm thresholds
    loading_pct = state.power_mw / GEN_RATED_MW  # 0–1
    state.level_m  = loading_pct * 10.0           # map to 0–10 m scale
    state.volume_l = loading_pct * TANK_VOLUME_L


def update_generic(state: PhysicsState, dt: float) -> None:
    """
    Multi-frequency configurable signal generator for demonstration scenarios.

    Produces four time-varying signals on the primary sensor registers:
      HR 0 (LEVEL_PV):     slow sine,  T = 120 s,  amplitude ±40, center 50
      HR 1 (FLOW_IN_PV):   medium sine, T = 60 s,  amplitude ±30, center 50
      HR 2 (FLOW_OUT_PV):  fast sine,  T = 30 s,   amplitude ±20, center 50
      HR 3 (PRESSURE_PV):  sawtooth ramp 0→100 % over 5 minutes, then reset
      HR 4 (TEMPERATURE_PV): constant 20 °C + slow Gaussian noise

    Signal values are in [0–100] normalized units, then write_pvs() applies
    the engineering-unit scale factors (e.g., signal 0 × 100 = HR0 in ×0.01 m
    → 50 normalized = 50 m displayed in FUXA/Grafana).

    Args:
        state: PhysicsState modified in-place (sim_time_s is the clock).
        dt:    Timestep in seconds (sim_time_s is advanced by the caller).
    """
    t = state.sim_time_s

    sig_level    = 50.0 + 40.0 * math.sin(2 * math.pi * t / 120.0)
    sig_flow_in  = 50.0 + 30.0 * math.sin(2 * math.pi * t / 60.0)
    sig_flow_out = 50.0 + 20.0 * math.sin(2 * math.pi * t / 30.0)
    sig_pressure = (t % 300.0) / 300.0 * 100.0 + RNG.gauss(0.0, 0.5)

    # Map normalized [0–100] signals to engineering units
    state.level_m      = sig_level    / 100.0 * 100.0    # 0–100 m
    state.flow_in_lpm  = sig_flow_in  / 100.0 * VALVE_FLOW_MAX_LPM
    state.flow_out_lpm = sig_flow_out / 100.0 * PUMP_FLOW_MAX_LPM
    state.pressure_bar = sig_pressure / 100.0 * 10.0     # 0–10 bar
    state.temperature_c = 20.0 + RNG.gauss(0.0, 0.2)

    # Volume for status/alarm evaluation (signal-level based)
    state.volume_l = sig_level / 100.0 * TANK_VOLUME_L


# ── Main simulation loop ───────────────────────────────────────────────────────

async def physics_loop(store: ModbusSlaveContext) -> None:
    """
    Asynchronous physics loop: read controls → run physics → write sensor values.

    Executes at SIM_DT_MS interval (default 1 Hz, matching typical SCADA rates).
    Between ticks, asyncio yields control to the Modbus TCP server so client
    connections are handled concurrently.

    Loop sequence per tick:
      1. read_coils()     — read digital control commands from Modbus coils
      2. read_setpoints() — read analog setpoints from HR 100–103
      3. Call process-type update function to advance physics by dt seconds
      4. _build_status()  — compute alarm and status bits for STATUS_WORD
      5. write_pvs()      — convert and write all sensor values to HR + IR

    Args:
        store: Shared ModbusSlaveContext (same instance used by the TCP server).
    """
    dt = SIM_DT_MS / 1000.0  # seconds per physics step

    # Initialise state with process-appropriate starting conditions
    initial_level_m = (INITIAL_LEVEL_PCT / 100.0) * (TANK_VOLUME_L / (TANK_AREA_M2 * 1000.0))
    state = PhysicsState(
        volume_l     = (INITIAL_LEVEL_PCT / 100.0) * TANK_VOLUME_L,
        level_m      = initial_level_m,
        pressure_bar = 5.0 if PROCESS_TYPE == "pipeline" else initial_level_m * 0.0981,
        freq_hz      = GEN_FREQ_BASE,
        voltage_pct  = 100.0,
        temperature_c = 20.0,
    )

    log.info(
        "Physics loop started: process=%s  dt=%.3f s  "
        "initial_volume=%.1f L  initial_level=%.2f m",
        PROCESS_TYPE, dt, state.volume_l, state.level_m,
    )

    tick = 0
    while True:
        await asyncio.sleep(dt)
        try:
            coils     = read_coils(store)
            setpoints = read_setpoints(store)

            # Dispatch to the appropriate physics model
            if PROCESS_TYPE == "water-tank":
                update_water_tank(state, coils, setpoints, dt)
            elif PROCESS_TYPE == "pipeline":
                update_pipeline(state, coils, setpoints, dt)
            elif PROCESS_TYPE == "generator":
                update_generator(state, coils, setpoints, dt)
            elif PROCESS_TYPE == "batch-reactor":
                update_batch_reactor(state, coils, dt)
            else:  # generic
                update_generic(state, dt)

            state.sim_time_s += dt

            status = _build_status(state, coils)
            write_pvs(store, state, status)

            # Periodic status log: once every 30 ticks (~30 s at 1 Hz)
            tick += 1
            if tick % 30 == 0:
                log.info(
                    "[%s] t=%.0f s | level=%.2f m | flow_in=%.1f L/min | "
                    "flow_out=%.1f L/min | P=%.2f bar | T=%.1f°C | "
                    "f=%.2f Hz | status=0x%04X",
                    PROCESS_TYPE, state.sim_time_s,
                    state.level_m, state.flow_in_lpm, state.flow_out_lpm,
                    state.pressure_bar, state.temperature_c,
                    state.freq_hz, status,
                )

        except Exception as exc:
            log.warning("Physics loop tick error: %s", exc)


async def main() -> None:
    """
    Entry point: starts the Modbus TCP server and physics loop concurrently.

    Creates a ModbusServerContext with a single slave keyed by UNIT_ID.
    The physics_loop coroutine is registered as an asyncio background task
    so the Modbus server handles client I/O while physics runs in parallel.

    All traffic is on 0.0.0.0:MODBUS_PORT (all interfaces inside the container).
    """
    log.info(
        "ICS Process Simulator — Device=%s  process=%s  unit=%d  port=%d  dt=%d ms",
        DEVICE_ID, PROCESS_TYPE, UNIT_ID, MODBUS_PORT, SIM_DT_MS,
    )
    # Logged unconditionally, including when the seed was drawn rather than
    # supplied: this line is what makes any past run replayable.
    log.info(
        "Noise stream seed: SIM_SEED=%d  (%s — set SIM_SEED to this value to replay)",
        SIM_SEED, "supplied" if _SEED_ENV not in (None, "") else "auto-generated",
    )

    # Build initial state to populate the datastore before the first physics tick
    initial_level_m = (INITIAL_LEVEL_PCT / 100.0) * (TANK_VOLUME_L / (TANK_AREA_M2 * 1000.0))
    initial_state = PhysicsState(
        volume_l     = (INITIAL_LEVEL_PCT / 100.0) * TANK_VOLUME_L,
        level_m      = initial_level_m,
        pressure_bar = 5.0 if PROCESS_TYPE == "pipeline" else initial_level_m * 0.0981,
        freq_hz      = GEN_FREQ_BASE,
        voltage_pct  = 100.0,
        temperature_c = 20.0,
    )

    store   = build_store(initial_state)
    context = ModbusServerContext(slaves={UNIT_ID: store}, single=False)

    # Register physics loop BEFORE starting the server so the first tick runs
    # immediately — avoids a race where a PLC polls before any values are computed
    asyncio.ensure_future(physics_loop(store))

    await StartAsyncTcpServer(context, address=("0.0.0.0", MODBUS_PORT))


if __name__ == "__main__":
    asyncio.run(main())
