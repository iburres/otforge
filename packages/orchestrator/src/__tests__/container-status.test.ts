/**
 * container-status.test.ts — Unit tests for reading container state from Docker.
 *
 * Why this matters: a container that crash-loops (Docker keeps restarting it) used to
 * show up as "stopped" or, between crashes, "running". A Suricata sensor killed by a
 * bad custom rule looked healthy, and the student lost days to "no alerts".
 *
 * Fixtures are verbatim output captured on Docker 28.3.2 (2026-10-07) from a compose
 * project with one container that exits 1 every 2 s under `restart: unless-stopped`.
 */

import { describe, it, expect } from 'vitest'
import { parseComposePs, parseRestartCounts } from '../docker-client'

/** Real `docker compose ps --format json` lines (trimmed to the fields we read). */
const PS_RESTARTING = [
  '{"Name":"crashtest-crasher-1","State":"restarting","Status":"Restarting (1) 1 second ago","Health":"","ExitCode":0}',
  '{"Name":"crashtest-healthy-1","State":"running","Status":"Up 13 seconds","Health":"","ExitCode":0}'
].join('\n')

/** The same crasher a moment later, caught in its "running" window between crashes. */
const PS_FLAPPED_RUNNING =
  '{"Name":"crashtest-crasher-1","State":"running","Status":"Up Less than a second","Health":"","ExitCode":0}\n'

/** Real `docker inspect --format "{{.Name}}|{{.RestartCount}}"` output. */
const INSPECT = '/crashtest-crasher-1|5\n/crashtest-healthy-1|0\n'

describe('parseComposePs', () => {
  it('reports a restarting container as restarting, not stopped', () => {
    const [crasher, healthy] = parseComposePs(PS_RESTARTING, 'crashtest')
    expect(crasher).toEqual({
      nodeId: 'crasher-1',
      containerId: 'crashtest-crasher-1',
      status: 'restarting',
      lastExitCode: 1
    })
    expect(healthy).toEqual({
      nodeId: 'healthy-1',
      containerId: 'crashtest-healthy-1',
      status: 'running'
    })
  })

  it('takes the exit code from the Status text, because ExitCode reads 0 while crash-looping', () => {
    const [crasher] = parseComposePs(PS_RESTARTING, 'crashtest')
    expect(crasher!.lastExitCode).toBe(1)
  })

  it('shows the crasher as plain running in its up-window, which is why restartCount is needed', () => {
    const [crasher] = parseComposePs(PS_FLAPPED_RUNNING, 'crashtest')
    expect(crasher!.status).toBe('running')
    expect(crasher!.lastExitCode).toBeUndefined()
  })

  it('maps health and other states as before', () => {
    const out = [
      '{"Name":"lab-plc-1","State":"running","Status":"Up 1 minute (healthy)","Health":"healthy"}',
      '{"Name":"lab-zeek","State":"exited","Status":"Exited (2) 3 seconds ago","Health":""}',
      '{"Name":"lab-fuxa","State":"created","Status":"Created","Health":""}'
    ].join('\n')
    expect(parseComposePs(out, 'lab')).toEqual([
      { nodeId: 'plc-1', containerId: 'lab-plc-1', status: 'running', healthCheck: 'healthy' },
      { nodeId: 'zeek', containerId: 'lab-zeek', status: 'error' },
      { nodeId: 'fuxa', containerId: 'lab-fuxa', status: 'starting' }
    ])
  })

  it('returns nothing for empty output', () => {
    expect(parseComposePs('', 'lab')).toEqual([])
    expect(parseComposePs('\n', 'lab')).toEqual([])
  })
})

describe('parseRestartCounts', () => {
  it('strips the leading slash so names match compose ps', () => {
    const counts = parseRestartCounts(INSPECT)
    expect(counts.get('crashtest-crasher-1')).toBe(5)
    expect(counts.get('crashtest-healthy-1')).toBe(0)
  })

  it('handles Windows line endings and ignores junk lines', () => {
    const counts = parseRestartCounts('/a|2\r\n\r\nnot a line\n/b|0')
    expect([...counts.entries()]).toEqual([
      ['a', 2],
      ['b', 0]
    ])
  })
})
