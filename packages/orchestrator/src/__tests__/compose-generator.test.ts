/**
 * compose-generator.test.ts — Unit tests for Docker Compose file generation.
 *
 * generateCompose() is the core of the simulation engine. A bug here means
 * containers get wrong IPs, wrong images, wrong capabilities, or wrong port
 * mappings — all silent until someone tries to run the scenario. These tests
 * catch regressions before they reach a user's machine.
 *
 * Testing approach:
 *   - Call generateCompose() with controlled scenario fixtures.
 *   - Parse the resulting YAML string with js-yaml.
 *   - Assert on the parsed object structure rather than on raw YAML text, so
 *     tests do not break when formatting or key ordering changes.
 *
 * Coverage target — each special-case branch in generateCompose():
 *   - All six Purdue Model zone networks emitted (ot, control, plant-dmz, enterprise,
 *     internet-dmz, attacker) even when the scenario only defines a subset
 *   - Firewall multi-zone attachment to ot-net + control-net + plant-dmz-net
 *   - Attack machine attacker-net isolation + capability grants + noVNC port
 *   - PLC web UI port publishing (deterministic sequential assignment)
 *   - Protocol environment variable injection (Modbus, DNP3, OPC-UA)
 *   - PLC program pre-load via INITIAL_PROGRAM_B64
 *   - Infrastructure services always present (Suricata, Zeek, InfluxDB, etc.)
 *   - Default zone subnet backfill for zones not defined in the scenario
 */

import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { generateCompose } from '../compose-generator'
import type { OTForgeScenario, DeviceConfig, NetworkZone } from '@otforge/schema'

// ── Parsed compose types ──────────────────────────────────────────────────────

interface ParsedService {
  image: string
  container_name: string
  restart: string
  networks: Record<string, { ipv4_address: string }>
  /** Host/bridge/none network mode. Set instead of networks for Suricata (AF_PACKET). */
  network_mode?: string
  environment?: string[]
  cap_add?: string[]
  ports?: string[]
  volumes?: string[]
  entrypoint?: string[]
  deploy: { resources: { limits: { memory: string; cpus: string } } }
}

interface ParsedCompose {
  name: string
  services: Record<string, ParsedService>
  networks: Record<
    string,
    {
      driver: string
      ipam: { config: Array<{ subnet: string; gateway: string }> }
    }
  >
  volumes?: Record<string, unknown>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generates compose YAML and returns the parsed object. */
function gen(scenario: OTForgeScenario, projectName = 'test-proj'): ParsedCompose {
  return yaml.load(generateCompose(scenario, projectName)) as ParsedCompose
}

type DeviceOverrides = Partial<DeviceConfig> & Pick<DeviceConfig, 'category' | 'ipAddress'>

/**
 * Builds a minimal type-correct OTForgeScenario for testing.
 * Only fields that generateCompose() reads are populated.
 */
function makeScenario(
  deviceEntries: Array<[string, DeviceOverrides]>,
  segmentZones: Array<{ zone: NetworkZone; subnet: string; gateway: string }> = []
): OTForgeScenario {
  const devices: OTForgeScenario['devices']['devices'] = {}
  for (const [id, d] of deviceEntries) {
    devices[id] = { nodeId: id, protocols: [], ...d }
  }
  return {
    meta: {
      formatVersion: '1.0',
      name: 'Test',
      description: '',
      sector: 'water-treatment',
      author: 'test',
      createdAt: '',
      updatedAt: '',
      appVersion: '0.1.0',
      locked: false,
      brief: '',
      requirements: { estimatedRamMb: 0, estimatedCpuCores: 0, containerCount: 0 }
    },
    visual: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    network: {
      segments: segmentZones.map(s => ({ ...s, dockerNetwork: `${s.zone}-net` })),
      routes: []
    },
    devices: { devices },
    security: {
      defaultFirewallPolicy: 'deny',
      firewallRules: [],
      ids: { enabledRulesets: [], disabledRuleIds: [], zeekScripts: [] },
      logging: { retentionDays: 30, influxdbEnabled: true, lokiEnabled: true }
    },
    registry: [],
    packLayers: []
  }
}

// ── Docker networks ───────────────────────────────────────────────────────────

describe('Docker networks', () => {
  it('always emits all six Purdue zone networks even when the scenario only defines one segment', () => {
    const scenario = makeScenario(
      [['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]],
      [{ zone: 'ot', subnet: '10.200.10.0/24', gateway: '10.200.10.1' }]
    )
    const compose = gen(scenario)
    expect(compose.networks).toHaveProperty('ot-net')
    expect(compose.networks).toHaveProperty('control-net')
    expect(compose.networks).toHaveProperty('plant-dmz-net')
    expect(compose.networks).toHaveProperty('enterprise-net')
    expect(compose.networks).toHaveProperty('internet-dmz-net')
    expect(compose.networks).toHaveProperty('attacker-net')
  })

  it('uses an explicit scenario subnet when a zone segment is provided', () => {
    const scenario = makeScenario(
      [['plc-1', { category: 'plc', ipAddress: '10.0.1.10' }]],
      [{ zone: 'ot', subnet: '10.0.1.0/24', gateway: '10.0.1.1' }]
    )
    const compose = gen(scenario)
    expect(compose.networks['ot-net'].ipam.config[0].subnet).toBe('10.0.1.0/24')
    expect(compose.networks['ot-net'].ipam.config[0].gateway).toBe('10.0.1.1')
  })

  it('fills in ZONE_DEFAULT subnets (10.200.x.0/24) for all zones not present in the scenario', () => {
    // No segments defined — all six zones should come from ZONE_DEFAULTS
    const scenario = makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]])
    const compose = gen(scenario)
    expect(compose.networks['ot-net'].ipam.config[0].subnet).toBe('10.200.10.0/24')
    expect(compose.networks['control-net'].ipam.config[0].subnet).toBe('10.200.20.0/24')
    expect(compose.networks['plant-dmz-net'].ipam.config[0].subnet).toBe('10.200.30.0/24')
    expect(compose.networks['enterprise-net'].ipam.config[0].subnet).toBe('10.200.40.0/24')
    expect(compose.networks['internet-dmz-net'].ipam.config[0].subnet).toBe('10.200.50.0/24')
    expect(compose.networks['attacker-net'].ipam.config[0].subnet).toBe('10.200.60.0/24')
  })

  it('sets driver to "bridge" for all zone networks', () => {
    const compose = gen(makeScenario([['s1', { category: 'sensor', ipAddress: '10.200.10.10' }]]))
    for (const net of Object.values(compose.networks)) {
      expect(net.driver).toBe('bridge')
    }
  })

  it('marks all Purdue zone networks as internal: true to block outbound internet', () => {
    // internal: true tells Docker not to add an outbound NAT route.
    // All OT/IT/enterprise/DMZ zones must be isolated — only Kali (attacker-net) is exempt.
    const compose = gen(makeScenario([['s1', { category: 'sensor', ipAddress: '10.200.10.10' }]]))
    const internalNets = [
      'ot-net',
      'control-net',
      'plant-dmz-net',
      'enterprise-net',
      'internet-dmz-net'
    ]
    for (const name of internalNets) {
      expect((compose.networks[name] as { internal?: boolean }).internal).toBe(true)
    }
  })

  it('does NOT mark attacker-net as internal — Kali needs outbound internet access', () => {
    const compose = gen(makeScenario([['s1', { category: 'sensor', ipAddress: '10.200.10.10' }]]))
    expect((compose.networks['attacker-net'] as { internal?: boolean }).internal).toBeUndefined()
  })
})

// ── Device service generation ─────────────────────────────────────────────────

describe('image assignment', () => {
  it('uses the GHCR OpenPLC image for PLC devices', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['plc-1'].image).toMatch(/otforge-openplc/)
  })

  it('uses the otforge-modbus image for RTU devices', () => {
    const compose = gen(makeScenario([['rtu-1', { category: 'rtu', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['rtu-1'].image).toBe('ghcr.io/iburres/otforge-modbus:latest')
  })

  it('uses the otforge-dnp3 image for IED devices', () => {
    const compose = gen(makeScenario([['ied-1', { category: 'ied', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['ied-1'].image).toBe('ghcr.io/iburres/otforge-dnp3:latest')
  })

  it('uses a custom dockerImage override when provided on the device', () => {
    const compose = gen(
      makeScenario([
        [
          'plc-custom',
          {
            category: 'plc',
            ipAddress: '10.200.10.10',
            dockerImage: 'my.registry.com/custom-plc:v2'
          }
        ]
      ])
    )
    expect(compose.services['plc-custom'].image).toBe('my.registry.com/custom-plc:v2')
  })

  it('gives smart-sensor the otforge-modbus image — a real container, not skipped', () => {
    const compose = gen(
      makeScenario([['sensor-1', { category: 'smart-sensor', ipAddress: '10.200.10.10' }]])
    )
    expect(compose.services['sensor-1']).toBeDefined()
    expect(compose.services['sensor-1'].image).toBe('ghcr.io/iburres/otforge-modbus:latest')
  })
})

describe('service name and container name', () => {
  it('lowercases node IDs and replaces underscores with hyphens', () => {
    const compose = gen(
      makeScenario([['PLC_Main_Unit', { category: 'plc', ipAddress: '10.200.10.10' }]])
    )
    expect(compose.services).toHaveProperty('plc-main-unit')
  })

  it('prefixes container_name with the project name', () => {
    const compose = gen(
      makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]]),
      'my-project'
    )
    expect(compose.services['plc-1'].container_name).toBe('my-project-plc-1')
  })

  it('sets project name from the projectName argument', () => {
    const compose = gen(
      makeScenario([['s1', { category: 'sensor', ipAddress: '10.200.10.10' }]]),
      'otforge-water-plant'
    )
    expect(compose.name).toBe('otforge-water-plant')
  })
})

describe('resource limits', () => {
  it('assigns 128m memory limit to PLC devices (OpenPLC needs Ubuntu + build tools)', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['plc-1'].deploy.resources.limits.memory).toBe('128m')
  })

  it('assigns 80m memory limit to RTU devices (pymodbus on Alpine)', () => {
    const compose = gen(makeScenario([['rtu-1', { category: 'rtu', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['rtu-1'].deploy.resources.limits.memory).toBe('80m')
  })

  it('assigns 2048m memory limit to attack machine (Kali + Xfce4 desktop + Metasploit)', () => {
    const compose = gen(
      makeScenario([['kali-1', { category: 'attack-machine', ipAddress: '10.200.60.10' }]])
    )
    expect(compose.services['kali-1'].deploy.resources.limits.memory).toBe('2048m')
  })
})

describe('network attachment', () => {
  it('attaches a device to the zone that contains its IP address', () => {
    const scenario = makeScenario(
      [['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]],
      [{ zone: 'ot', subnet: '10.200.10.0/24', gateway: '10.200.10.1' }]
    )
    const compose = gen(scenario)
    expect(compose.services['plc-1'].networks).toHaveProperty('ot-net')
    expect(compose.services['plc-1'].networks['ot-net'].ipv4_address).toBe('10.200.10.10')
  })

  it('attaches a control-zone device to control-net', () => {
    // 'hmi'/'historian' categories never get their own container (see the guard
    // in compose-generator.ts's device loop) -- 'application-server' is used
    // here instead as an equally control-zone-appropriate category that does.
    const scenario = makeScenario(
      [['app-1', { category: 'application-server', ipAddress: '10.200.20.10' }]],
      [{ zone: 'control', subnet: '10.200.20.0/24', gateway: '10.200.20.1' }]
    )
    const compose = gen(scenario)
    expect(compose.services['app-1'].networks).toHaveProperty('control-net')
    expect(compose.services['app-1'].networks['control-net'].ipv4_address).toBe('10.200.20.10')
  })

  it('never creates a container for hmi/historian devices — the fixed fuxa/influxdb services already cover that role', () => {
    const scenario = makeScenario([
      ['hmi-1', { category: 'hmi', ipAddress: '10.200.20.10' }],
      ['historian-1', { category: 'historian', ipAddress: '10.200.20.11' }]
    ])
    const compose = gen(scenario)
    expect(compose.services['hmi-1']).toBeUndefined()
    expect(compose.services['historian-1']).toBeUndefined()
    // The fixed infrastructure services are still present and unaffected.
    expect(compose.services['fuxa']).toBeDefined()
    expect(compose.services['influxdb']).toBeDefined()
  })

  it('falls back to ot-net when the device IP does not match any defined segment', () => {
    const scenario = makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]])
    const compose = gen(scenario)
    expect(compose.services['plc-1'].networks).toHaveProperty('ot-net')
  })

  it('sets restart to "unless-stopped" for all device services', () => {
    const compose = gen(makeScenario([['s1', { category: 'sensor', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['s1'].restart).toBe('unless-stopped')
  })
})

// ── Special device categories ─────────────────────────────────────────────────

describe('firewall device', () => {
  /**
   * Firewall bridges OT (L0-L2), Control Center (L3), and Plant DMZ (L3.5)
   * simultaneously to enforce inter-zone ACLs via nftables rules.
   * It must NOT be on the attacker network — the Red Team zone is intentionally
   * separated from the Purdue zone stack.
   */
  const firewallCompose = () =>
    gen(makeScenario([['fw-1', { category: 'firewall', ipAddress: '10.200.10.254' }]]))

  it('attaches to ot-net, control-net, and plant-dmz-net simultaneously', () => {
    const nets = Object.keys(firewallCompose().services['fw-1'].networks)
    expect(nets).toContain('ot-net')
    expect(nets).toContain('control-net')
    expect(nets).toContain('plant-dmz-net')
  })

  it('attaches to attacker-net so Kali traffic is subject to nftables rules', () => {
    const nets = Object.keys(firewallCompose().services['fw-1'].networks)
    expect(nets).toContain('attacker-net')
  })

  it('does NOT attach to enterprise-net or internet-dmz-net', () => {
    const nets = Object.keys(firewallCompose().services['fw-1'].networks)
    expect(nets).not.toContain('enterprise-net')
    expect(nets).not.toContain('internet-dmz-net')
  })

  it('grants NET_ADMIN for nftables rule management', () => {
    expect(firewallCompose().services['fw-1'].cap_add).toContain('NET_ADMIN')
  })

  it('grants NET_RAW for ICMP and raw socket access', () => {
    expect(firewallCompose().services['fw-1'].cap_add).toContain('NET_RAW')
  })
})

describe('attack-machine device', () => {
  /**
   * Kali Linux is dual-homed: attacker-net (primary — has outbound internet access
   * because no internal: true) and internet-dmz-net (second leg — gives Kali direct
   * L2 adjacency to the web server and DNS server in the Internet DMZ zone).
   * This lets students run curl/nmap/exploits against scenario targets without
   * needing internet access on the target hosts, which are all on internal: true networks.
   */
  const attackCompose = () =>
    gen(makeScenario([['kali-1', { category: 'attack-machine', ipAddress: '10.200.60.10' }]]))

  it('attaches to attacker-net (primary) and internet-dmz-net (target reach)', () => {
    const nets = Object.keys(attackCompose().services['kali-1'].networks)
    expect(nets).toContain('attacker-net')
    expect(nets).toContain('internet-dmz-net')
  })

  it('does NOT attach to OT, Control, Plant-DMZ, or Enterprise networks', () => {
    const nets = Object.keys(attackCompose().services['kali-1'].networks)
    expect(nets).not.toContain('ot-net')
    expect(nets).not.toContain('control-net')
    expect(nets).not.toContain('plant-dmz-net')
    expect(nets).not.toContain('enterprise-net')
  })

  it('grants NET_ADMIN and NET_RAW for nmap raw scans and ARP operations', () => {
    expect(attackCompose().services['kali-1'].cap_add).toContain('NET_ADMIN')
    expect(attackCompose().services['kali-1'].cap_add).toContain('NET_RAW')
  })

  it('preserves the static IP on attacker-net', () => {
    expect(attackCompose().services['kali-1'].networks['attacker-net'].ipv4_address).toBe(
      '10.200.60.10'
    )
  })

  it('assigns .250 on internet-dmz-net (reserved system-service slot for Kali)', () => {
    const ip = attackCompose().services['kali-1'].networks['internet-dmz-net'].ipv4_address
    expect(ip).toBe('10.200.50.250')
  })

  it('publishes noVNC port 6080 on deterministic host port 6900 for the first attack machine', () => {
    // Phase 12: switched from linuxserver KasmVNC (:3000) to otforge-attack-base noVNC (:6080)
    expect(attackCompose().services['kali-1'].ports).toContain('6900:6080')
  })

  it('assigns sequential host ports to multiple attack machines — 6900, 6901, etc.', () => {
    const compose = gen(
      makeScenario([
        ['kali-1', { category: 'attack-machine', ipAddress: '10.200.60.10' }],
        ['kali-2', { category: 'attack-machine', ipAddress: '10.200.60.11' }]
      ])
    )
    expect(compose.services['kali-1'].ports).toContain('6900:6080')
    expect(compose.services['kali-2'].ports).toContain('6901:6080')
  })

  it('sets dns: to the dns-server device IP when one is present in the scenario', () => {
    const scenario = makeScenario(
      [
        ['kali-1', { category: 'attack-machine', ipAddress: '10.200.60.10' }],
        ['dns-1', { category: 'dns-server', ipAddress: '10.200.50.5' }]
      ],
      [
        { zone: 'attacker', subnet: '10.200.60.0/24', gateway: '10.200.60.1' },
        { zone: 'internet-dmz', subnet: '10.200.50.0/24', gateway: '10.200.50.1' }
      ]
    )
    const compose = gen(scenario)
    // dns: field must include the scenario dns-server IP first, then 8.8.8.8 as a public
    // fallback so Kali can resolve external names via attacker-net even when the scenario's
    // DNS server is air-gapped (DNS_UPSTREAM="").
    expect((compose.services['kali-1'] as { dns?: string[] }).dns).toEqual([
      '10.200.50.5',
      '8.8.8.8'
    ])
  })

  it('does NOT set dns: when no dns-server device is in the scenario', () => {
    const compose = attackCompose()
    expect((compose.services['kali-1'] as { dns?: string[] }).dns).toBeUndefined()
  })
})

describe('profinet-device', () => {
  it('uses the otforge-profinet image', () => {
    const compose = gen(
      makeScenario([['pn-1', { category: 'profinet-device', ipAddress: '10.200.10.10' }]])
    )
    expect(compose.services['pn-1'].image).toBe('ghcr.io/iburres/otforge-profinet:latest')
  })

  it('assigns 64m memory limit (hand-rolled raw-socket DCP server on Alpine)', () => {
    const compose = gen(
      makeScenario([['pn-1', { category: 'profinet-device', ipAddress: '10.200.10.10' }]])
    )
    expect(compose.services['pn-1'].deploy.resources.limits.memory).toBe('64m')
  })

  it('grants NET_ADMIN and NET_RAW for its raw AF_PACKET DCP socket', () => {
    const compose = gen(
      makeScenario([['pn-1', { category: 'profinet-device', ipAddress: '10.200.10.10' }]])
    )
    expect(compose.services['pn-1'].cap_add).toContain('NET_ADMIN')
    expect(compose.services['pn-1'].cap_add).toContain('NET_RAW')
  })

  it('injects PROFINET_STATION_NAME, PROFINET_VENDOR_ID, PROFINET_DEVICE_ID when a profinet config is present', () => {
    const compose = gen(
      makeScenario([
        [
          'pn-1',
          {
            category: 'profinet-device',
            ipAddress: '10.200.10.10',
            profinet: { stationName: 'press-station-3', vendorId: 42, deviceId: 7 }
          }
        ]
      ])
    )
    const env = compose.services['pn-1'].environment ?? []
    expect(env).toContain('PROFINET_STATION_NAME=press-station-3')
    expect(env).toContain('PROFINET_VENDOR_ID=42')
    expect(env).toContain('PROFINET_DEVICE_ID=7')
  })

  it('does not inject PROFINET_* vars when no profinet config is present', () => {
    const compose = gen(
      makeScenario([['pn-1', { category: 'profinet-device', ipAddress: '10.200.10.10' }]])
    )
    const env = compose.services['pn-1'].environment ?? []
    expect(env.some(e => e.startsWith('PROFINET_'))).toBe(false)
  })
})

describe('ip-camera — dual-homed pivot device', () => {
  const zones = [
    { zone: 'internet-dmz' as const, subnet: '10.200.50.0/24', gateway: '10.200.50.1' },
    { zone: 'control' as const, subnet: '10.200.20.0/24', gateway: '10.200.20.1' },
    { zone: 'ot' as const, subnet: '10.200.10.0/24', gateway: '10.200.10.1' }
  ]

  it('uses the otforge-camera image', () => {
    const compose = gen(
      makeScenario([['cam-1', { category: 'ip-camera', ipAddress: '10.200.50.15' }]], zones)
    )
    expect(compose.services['cam-1'].image).toBe('ghcr.io/iburres/otforge-camera:latest')
  })

  it('assigns 32m memory limit (Alpine + openssh-server, tiny footprint)', () => {
    const compose = gen(
      makeScenario([['cam-1', { category: 'ip-camera', ipAddress: '10.200.50.15' }]], zones)
    )
    expect(compose.services['cam-1'].deploy.resources.limits.memory).toBe('32m')
  })

  it('attaches to its primary zone plus each extraNetworks zone', () => {
    const compose = gen(
      makeScenario(
        [
          [
            'cam-1',
            { category: 'ip-camera', ipAddress: '10.200.50.15', extraNetworks: ['control'] }
          ]
        ],
        zones
      )
    )
    const nets = Object.keys(compose.services['cam-1'].networks)
    expect(nets).toContain('internet-dmz-net')
    expect(nets).toContain('control-net')
  })

  it('routes zones NOT directly attached (e.g. OT) through the firewall via the extraNetworks leg', () => {
    const compose = gen(
      makeScenario(
        [
          [
            'cam-1',
            { category: 'ip-camera', ipAddress: '10.200.50.15', extraNetworks: ['control'] }
          ]
        ],
        zones
      )
    )
    const entrypoint = compose.services['cam-1'].entrypoint?.join(' ') ?? ''
    // Control's firewall IP is its subnet base + .254 (10.200.20.254) — OT traffic
    // (a zone the camera has no direct interface on) must route through it.
    expect(entrypoint).toContain('ip route replace 10.200.10.0/24 via 10.200.20.254')
  })

  it('does NOT add a route override for a zone the camera has no extraNetworks at all', () => {
    const compose = gen(
      makeScenario([['cam-1', { category: 'ip-camera', ipAddress: '10.200.50.15' }]], zones)
    )
    expect(compose.services['cam-1'].entrypoint).toBeUndefined()
  })

  it('grants NET_ADMIN when a route override is added (ip route replace needs it)', () => {
    const compose = gen(
      makeScenario(
        [
          [
            'cam-1',
            { category: 'ip-camera', ipAddress: '10.200.50.15', extraNetworks: ['control'] }
          ]
        ],
        zones
      )
    )
    expect(compose.services['cam-1'].cap_add).toContain('NET_ADMIN')
  })

  it('does NOT grant NET_ADMIN when there is no extraNetworks leg (nothing to route)', () => {
    const compose = gen(
      makeScenario([['cam-1', { category: 'ip-camera', ipAddress: '10.200.50.15' }]], zones)
    )
    expect(compose.services['cam-1'].cap_add).toBeUndefined()
  })
})

describe('attack-machine — Insider Threat mode (visual zone placement)', () => {
  /**
   * Insider Threat mode (scenario.security.insiderThreat) lets the attack machine
   * be dropped from the palette directly onto an internal Purdue tab instead of
   * added via the toolbar (which never creates a visual node — see
   * ScadaCanvas.tsx onDrop). Its canvas node's zone should grant it a real,
   * additional network leg there, on top of the default attacker-net +
   * internet-dmz-net dual-homing every attack machine gets.
   */
  function insiderScenario(zone: NetworkZone): OTForgeScenario {
    const scenario = makeScenario([
      ['kali-1', { category: 'attack-machine', ipAddress: '10.200.60.10' }]
    ])
    scenario.visual.nodes = [
      {
        id: 'kali-1',
        type: 'attack-machine',
        position: { x: 0, y: 0 },
        data: { label: 'Kali', zone }
      }
    ]
    return scenario
  }

  it('adds the dropped-tab zone as a third network leg', () => {
    const compose = gen(insiderScenario('enterprise'))
    const nets = Object.keys(compose.services['kali-1'].networks)
    expect(nets).toEqual(
      expect.arrayContaining(['attacker-net', 'internet-dmz-net', 'enterprise-net'])
    )
  })

  it('assigns the insider leg an IP in the .200-.239 extra-network range', () => {
    const compose = gen(insiderScenario('enterprise'))
    expect(compose.services['kali-1'].networks['enterprise-net'].ipv4_address).toBe('10.200.40.200')
  })

  it('does not duplicate/conflict when dropped on the internet-dmz tab (already a default leg)', () => {
    const compose = gen(insiderScenario('internet-dmz'))
    const nets = Object.keys(compose.services['kali-1'].networks)
    expect(nets).toEqual(['attacker-net', 'internet-dmz-net'])
  })

  it('still attaches only the two default legs when no visual node exists (default external-attacker case)', () => {
    const compose = gen(
      makeScenario([['kali-1', { category: 'attack-machine', ipAddress: '10.200.60.10' }]])
    )
    const nets = Object.keys(compose.services['kali-1'].networks)
    expect(nets).toEqual(['attacker-net', 'internet-dmz-net'])
  })

  it('omits the insider drop-zone *_SUBNET env so entrypoint.sh will not steal the connected route', () => {
    const env = gen(insiderScenario('ot')).services['kali-1'].environment ?? []
    expect(env.some(e => e.startsWith('OT_SUBNET='))).toBe(false)
    expect(env).toContain('CONTROL_SUBNET=10.200.20.0/24')
    expect(env).toContain('PLANT_DMZ_SUBNET=10.200.30.0/24')
  })
})

// ── PLC port publishing ───────────────────────────────────────────────────────

describe('PLC port publishing', () => {
  it('publishes OpenPLC web UI on host port 18080 for the first PLC', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['plc-1'].ports).toContain('18080:8080')
  })

  it('assigns sequential host ports to multiple PLCs — 18080, 18081, etc.', () => {
    // Object.entries() preserves insertion order (V8 guarantee for string keys),
    // mirroring the same ordering used by main/index.ts to build activePlcPorts.
    const compose = gen(
      makeScenario([
        ['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }],
        ['plc-2', { category: 'plc', ipAddress: '10.200.10.11' }]
      ])
    )
    expect(compose.services['plc-1'].ports).toContain('18080:8080')
    expect(compose.services['plc-2'].ports).toContain('18081:8080')
  })

  it('does not publish any ports for non-PLC devices', () => {
    const compose = gen(makeScenario([['rtu-1', { category: 'rtu', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['rtu-1'].ports).toBeUndefined()
  })
})

// ── Environment variable injection ────────────────────────────────────────────

describe('environment variable injection', () => {
  it('always injects DEVICE_ID and DEVICE_CATEGORY for every device', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]]))
    const env = compose.services['plc-1'].environment ?? []
    expect(env).toContain('DEVICE_ID=plc-1')
    expect(env).toContain('DEVICE_CATEGORY=plc')
  })

  it('injects MODBUS_MODE, MODBUS_PORT, MODBUS_UNIT_ID when a Modbus config is present', () => {
    const compose = gen(
      makeScenario([
        [
          'rtu-1',
          {
            category: 'rtu',
            ipAddress: '10.200.10.10',
            modbus: { mode: 'tcp', port: 502, unitId: 5, registers: {} }
          }
        ]
      ])
    )
    const env = compose.services['rtu-1'].environment ?? []
    expect(env).toContain('MODBUS_MODE=tcp')
    expect(env).toContain('MODBUS_PORT=502')
    expect(env).toContain('MODBUS_UNIT_ID=5')
  })

  it('injects SENSOR_* vars when a smart-sensor config is present', () => {
    const compose = gen(
      makeScenario([
        [
          'sensor-1',
          {
            category: 'smart-sensor',
            ipAddress: '10.200.10.10',
            sensor: {
              kind: 'flow',
              waveform: 'sawtooth',
              minValue: 0,
              maxValue: 300,
              noisePercent: 5,
              modbusRegister: 12
            }
          }
        ]
      ])
    )
    const env = compose.services['sensor-1'].environment ?? []
    expect(env).toContain('SENSOR_KIND=flow')
    expect(env).toContain('SENSOR_WAVEFORM=sawtooth')
    expect(env).toContain('SENSOR_MIN_VALUE=0')
    expect(env).toContain('SENSOR_MAX_VALUE=300')
    expect(env).toContain('SENSOR_NOISE_PERCENT=5')
    expect(env).toContain('SENSOR_MODBUS_REGISTER=12')
  })

  it('injects DNP3_* vars when a DNP3 config is present', () => {
    const compose = gen(
      makeScenario([
        [
          'ied-1',
          {
            category: 'ied',
            ipAddress: '10.200.10.10',
            dnp3: { masterAddress: 1, outstationAddress: 10, port: 20000 }
          }
        ]
      ])
    )
    const env = compose.services['ied-1'].environment ?? []
    expect(env).toContain('DNP3_MASTER_ADDRESS=1')
    expect(env).toContain('DNP3_OUTSTATION_ADDRESS=10')
    expect(env).toContain('DNP3_PORT=20000')
  })

  it('injects OPCUA_PORT and OPCUA_NAMESPACE when an OPC-UA config is present', () => {
    const compose = gen(
      makeScenario([
        [
          'plc-1',
          {
            category: 'plc',
            ipAddress: '10.200.10.10',
            opcua: { port: 4840, namespace: 'urn:icslab:plc', nodes: [] }
          }
        ]
      ])
    )
    const env = compose.services['plc-1'].environment ?? []
    expect(env).toContain('OPCUA_PORT=4840')
    expect(env).toContain('OPCUA_NAMESPACE=urn:icslab:plc')
  })

  it('injects INITIAL_PROGRAM_B64 when a saved PLC program source exists', () => {
    const b64 = Buffer.from('PROGRAM main VAR END_VAR END_PROGRAM').toString('base64')
    const compose = gen(
      makeScenario([
        [
          'plc-1',
          {
            category: 'plc',
            ipAddress: '10.200.10.10',
            plcProgram: {
              language: 'st',
              source: b64,
              variables: [
                {
                  name: 'pressure',
                  type: 'REAL',
                  address: '%IW0',
                  protocol: 'modbus-tcp',
                  protocolAddress: '0'
                }
              ]
            }
          }
        ]
      ])
    )
    const env = compose.services['plc-1'].environment ?? []
    expect(env).toContain(`INITIAL_PROGRAM_B64=${b64}`)
  })

  it('injects PLC_VAR_COUNT equal to the number of variable bindings', () => {
    const b64 = Buffer.from('PROGRAM main VAR END_VAR END_PROGRAM').toString('base64')
    const compose = gen(
      makeScenario([
        [
          'plc-1',
          {
            category: 'plc',
            ipAddress: '10.200.10.10',
            plcProgram: {
              language: 'st',
              source: b64,
              variables: [
                {
                  name: 'v1',
                  type: 'BOOL',
                  address: '%IX0.0',
                  protocol: 'modbus-tcp',
                  protocolAddress: '0'
                },
                {
                  name: 'v2',
                  type: 'BOOL',
                  address: '%QX0.0',
                  protocol: 'modbus-tcp',
                  protocolAddress: '0'
                }
              ]
            }
          }
        ]
      ])
    )
    const env = compose.services['plc-1'].environment ?? []
    expect(env).toContain('PLC_VAR_COUNT=2')
  })

  it('injects edge-aware auto ST when PLC has no authored plcProgram', () => {
    const scenario = makeScenario([
      ['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }],
      [
        'pump-1',
        { category: 'smart-controller', ipAddress: '10.200.10.11', controller: { kind: 'pump' } }
      ]
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'plc-1', target: 'pump-1', data: { protocol: 'modbus-tcp' } }
    ]
    const b64 = (gen(scenario).services['plc-1'].environment ?? [])
      .find(v => v.startsWith('INITIAL_PROGRAM_B64='))
      ?.slice('INITIAL_PROGRAM_B64='.length)
    expect(Buffer.from(b64!, 'base64').toString()).toContain('pump_1_run AT %QX0.0')
  })
})

describe('dcs-controller — real device', () => {
  it('gives dcs-controller the otforge-dcs image — a real container, not the alpine stub', () => {
    const compose = gen(
      makeScenario([['dcs-1', { category: 'dcs-controller', ipAddress: '10.200.10.10' }]])
    )
    expect(compose.services['dcs-1']).toBeDefined()
    expect(compose.services['dcs-1'].image).toBe('ghcr.io/iburres/otforge-dcs:latest')
  })

  it('assigns the 128m/0.5 resource limit to dcs-controller', () => {
    const compose = gen(
      makeScenario([['dcs-1', { category: 'dcs-controller', ipAddress: '10.200.10.10' }]])
    )
    expect(compose.services['dcs-1'].deploy.resources.limits.memory).toBe('128m')
    expect(compose.services['dcs-1'].deploy.resources.limits.cpus).toBe('0.5')
  })

  it('injects DCS_FIELD_DEVICES from a single edge to a smart-controller', () => {
    const scenario = makeScenario([
      ['dcs-1', { category: 'dcs-controller', ipAddress: '10.200.10.10' }],
      [
        'pump-1',
        { category: 'smart-controller', ipAddress: '10.200.10.11', controller: { kind: 'pump' } }
      ]
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'dcs-1', target: 'pump-1', data: { protocol: 'modbus-tcp' } }
    ]
    const env = gen(scenario).services['dcs-1'].environment ?? []
    expect(env).toContain('DCS_FIELD_DEVICES=pump-1|10.200.10.11')
  })

  it('injects DCS_FIELD_DEVICES as a comma-separated list from multiple edges', () => {
    const scenario = makeScenario([
      ['dcs-1', { category: 'dcs-controller', ipAddress: '10.200.10.10' }],
      [
        'pump-1',
        { category: 'smart-controller', ipAddress: '10.200.10.11', controller: { kind: 'pump' } }
      ],
      ['sensor-1', { category: 'smart-sensor', ipAddress: '10.200.10.12' }]
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'dcs-1', target: 'pump-1', data: { protocol: 'modbus-tcp' } },
      { id: 'e2', source: 'sensor-1', target: 'dcs-1', data: { protocol: 'modbus-tcp' } }
    ]
    const env = gen(scenario).services['dcs-1'].environment ?? []
    const fieldDevicesEnv = env.find(v => v.startsWith('DCS_FIELD_DEVICES='))
    expect(fieldDevicesEnv).toBeDefined()
    const entries = fieldDevicesEnv!.slice('DCS_FIELD_DEVICES='.length).split(',')
    expect(entries).toEqual(
      expect.arrayContaining(['pump-1|10.200.10.11', 'sensor-1|10.200.10.12'])
    )
    expect(entries).toHaveLength(2)
  })

  it('omits DCS_FIELD_DEVICES entirely when the DCS has no connecting edges', () => {
    const compose = gen(
      makeScenario([['dcs-1', { category: 'dcs-controller', ipAddress: '10.200.10.10' }]])
    )
    const env = compose.services['dcs-1'].environment ?? []
    expect(env.some(v => v.startsWith('DCS_FIELD_DEVICES'))).toBe(false)
  })

  it('does not pull an edge to an unrelated category (e.g. hmi) into the field-device list', () => {
    const scenario = makeScenario([
      ['dcs-1', { category: 'dcs-controller', ipAddress: '10.200.10.10' }],
      ['hmi-1', { category: 'hmi', ipAddress: '10.200.20.10' }]
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'dcs-1', target: 'hmi-1', data: { protocol: 'opc-ua' } }
    ]
    const env = gen(scenario).services['dcs-1'].environment ?? []
    expect(env.some(v => v.startsWith('DCS_FIELD_DEVICES'))).toBe(false)
  })
})

describe('iiot-sensor — MQTT publisher', () => {
  it('gives iiot-sensor the otforge-iiot-sensor image — a real container, not the alpine stub', () => {
    const compose = gen(
      makeScenario([['sensor-1', { category: 'iiot-sensor', ipAddress: '10.200.10.30' }]])
    )
    expect(compose.services['sensor-1']).toBeDefined()
    expect(compose.services['sensor-1'].image).toBe('ghcr.io/iburres/otforge-iiot-sensor:latest')
  })

  it('assigns the 64m/0.1 resource limit to iiot-sensor', () => {
    const compose = gen(
      makeScenario([['sensor-1', { category: 'iiot-sensor', ipAddress: '10.200.10.30' }]])
    )
    expect(compose.services['sensor-1'].deploy.resources.limits.memory).toBe('64m')
    expect(compose.services['sensor-1'].deploy.resources.limits.cpus).toBe('0.1')
  })

  it('injects MQTT_BROKER_IP from a direct edge to an iot-gateway', () => {
    const scenario = makeScenario([
      ['sensor-1', { category: 'iiot-sensor', ipAddress: '10.200.10.30' }],
      ['gateway-1', { category: 'iot-gateway', ipAddress: '10.200.10.31' }]
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'sensor-1', target: 'gateway-1', data: { protocol: 'mqtt' } }
    ]
    const env = gen(scenario).services['sensor-1'].environment ?? []
    expect(env).toContain('MQTT_BROKER_IP=10.200.10.31')
  })

  it('omits MQTT_BROKER_IP entirely when the iiot-sensor has no connecting edges', () => {
    const compose = gen(
      makeScenario([['sensor-1', { category: 'iiot-sensor', ipAddress: '10.200.10.30' }]])
    )
    const env = compose.services['sensor-1'].environment ?? []
    expect(env.some(v => v.startsWith('MQTT_BROKER_IP'))).toBe(false)
  })
})

describe('iot-gateway — real MQTT broker + Modbus bridge', () => {
  it('gives iot-gateway the otforge-iot-gateway image — a real container, not the alpine stub', () => {
    const compose = gen(
      makeScenario([['gateway-1', { category: 'iot-gateway', ipAddress: '10.200.10.31' }]])
    )
    expect(compose.services['gateway-1']).toBeDefined()
    expect(compose.services['gateway-1'].image).toBe('ghcr.io/iburres/otforge-iot-gateway:latest')
  })

  it('assigns the 96m/0.2 resource limit to iot-gateway', () => {
    const compose = gen(
      makeScenario([['gateway-1', { category: 'iot-gateway', ipAddress: '10.200.10.31' }]])
    )
    expect(compose.services['gateway-1'].deploy.resources.limits.memory).toBe('96m')
    expect(compose.services['gateway-1'].deploy.resources.limits.cpus).toBe('0.2')
  })

  it('injects GATEWAY_FIELD_DEVICES from a single edge to a smart-sensor', () => {
    const scenario = makeScenario([
      ['gateway-1', { category: 'iot-gateway', ipAddress: '10.200.10.31' }],
      ['sensor-1', { category: 'smart-sensor', ipAddress: '10.200.10.12' }]
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'gateway-1', target: 'sensor-1', data: { protocol: 'modbus-tcp' } }
    ]
    const env = gen(scenario).services['gateway-1'].environment ?? []
    expect(env).toContain('GATEWAY_FIELD_DEVICES=sensor-1|10.200.10.12')
  })

  it('injects GATEWAY_FIELD_DEVICES as a comma-separated list from multiple edges', () => {
    const scenario = makeScenario([
      ['gateway-1', { category: 'iot-gateway', ipAddress: '10.200.10.31' }],
      [
        'pump-1',
        { category: 'smart-controller', ipAddress: '10.200.10.11', controller: { kind: 'pump' } }
      ],
      ['sensor-1', { category: 'smart-sensor', ipAddress: '10.200.10.12' }]
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'gateway-1', target: 'pump-1', data: { protocol: 'modbus-tcp' } },
      { id: 'e2', source: 'sensor-1', target: 'gateway-1', data: { protocol: 'modbus-tcp' } }
    ]
    const env = gen(scenario).services['gateway-1'].environment ?? []
    const fieldDevicesEnv = env.find(v => v.startsWith('GATEWAY_FIELD_DEVICES='))
    expect(fieldDevicesEnv).toBeDefined()
    const entries = fieldDevicesEnv!.slice('GATEWAY_FIELD_DEVICES='.length).split(',')
    expect(entries).toEqual(
      expect.arrayContaining(['pump-1|10.200.10.11', 'sensor-1|10.200.10.12'])
    )
    expect(entries).toHaveLength(2)
  })

  it('omits GATEWAY_FIELD_DEVICES entirely when the gateway has no connecting field-device edges', () => {
    const compose = gen(
      makeScenario([['gateway-1', { category: 'iot-gateway', ipAddress: '10.200.10.31' }]])
    )
    const env = compose.services['gateway-1'].environment ?? []
    expect(env.some(v => v.startsWith('GATEWAY_FIELD_DEVICES'))).toBe(false)
  })

  it('does not pull an edge to an unrelated category (e.g. hmi) into the field-device list', () => {
    const scenario = makeScenario([
      ['gateway-1', { category: 'iot-gateway', ipAddress: '10.200.10.31' }],
      ['hmi-1', { category: 'hmi', ipAddress: '10.200.20.10' }]
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'gateway-1', target: 'hmi-1', data: { protocol: 'opc-ua' } }
    ]
    const env = gen(scenario).services['gateway-1'].environment ?? []
    expect(env.some(v => v.startsWith('GATEWAY_FIELD_DEVICES'))).toBe(false)
  })
})

describe('pmu — real IEEE C37.118 device', () => {
  function generatorUnit(id: string, ip: string): [string, DeviceOverrides] {
    return [
      id,
      { category: 'process-unit', ipAddress: ip, processUnit: { processType: 'generator' } }
    ]
  }

  it('gives pmu the otforge-pmu image — a real container, not a stub', () => {
    const compose = gen(makeScenario([['pmu-1', { category: 'pmu', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['pmu-1']).toBeDefined()
    expect(compose.services['pmu-1'].image).toBe('ghcr.io/iburres/otforge-pmu:latest')
  })

  it('assigns the 64m/0.25 resource limit to pmu', () => {
    const compose = gen(makeScenario([['pmu-1', { category: 'pmu', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['pmu-1'].deploy.resources.limits.memory).toBe('64m')
    expect(compose.services['pmu-1'].deploy.resources.limits.cpus).toBe('0.25')
  })

  it('injects GENERATOR_IP from a direct edge to a generator process-unit', () => {
    const scenario = makeScenario([
      ['pmu-1', { category: 'pmu', ipAddress: '10.200.10.10' }],
      generatorUnit('gen-1', '10.200.10.20')
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'pmu-1', target: 'gen-1', data: { protocol: 'modbus-tcp' } }
    ]
    const env = gen(scenario).services['pmu-1'].environment ?? []
    expect(env).toContain('GENERATOR_IP=10.200.10.20')
  })

  it('omits GENERATOR_IP entirely when the pmu has no connecting edges', () => {
    const compose = gen(makeScenario([['pmu-1', { category: 'pmu', ipAddress: '10.200.10.10' }]]))
    const env = compose.services['pmu-1'].environment ?? []
    expect(env.some(v => v.startsWith('GENERATOR_IP'))).toBe(false)
  })

  it('does not wire GENERATOR_IP to a non-generator process-unit (e.g. water-tank)', () => {
    const scenario = makeScenario([
      ['pmu-1', { category: 'pmu', ipAddress: '10.200.10.10' }],
      [
        'tank-1',
        {
          category: 'process-unit',
          ipAddress: '10.200.10.20',
          processUnit: { processType: 'water-tank' }
        }
      ]
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'pmu-1', target: 'tank-1', data: { protocol: 'modbus-tcp' } }
    ]
    const env = gen(scenario).services['pmu-1'].environment ?? []
    expect(env.some(v => v.startsWith('GENERATOR_IP'))).toBe(false)
  })

  it('injects PMU_* station-identity env vars from device.pmu config', () => {
    const compose = gen(
      makeScenario([
        [
          'pmu-1',
          {
            category: 'pmu',
            ipAddress: '10.200.10.10',
            pmu: { idCode: 42, stationName: 'North Bus PMU', dataRateFps: 60, nominalFreqHz: 50 }
          }
        ]
      ])
    )
    const env = compose.services['pmu-1'].environment ?? []
    expect(env).toContain('PMU_IDCODE=42')
    expect(env).toContain('PMU_STATION_NAME=North Bus PMU')
    expect(env).toContain('PMU_DATA_RATE_FPS=60')
    expect(env).toContain('PMU_NOMINAL_FREQ_HZ=50')
  })

  it('omits PMU_* env vars when device.pmu is not set', () => {
    const compose = gen(makeScenario([['pmu-1', { category: 'pmu', ipAddress: '10.200.10.10' }]]))
    const env = compose.services['pmu-1'].environment ?? []
    expect(env.some(v => v.startsWith('PMU_'))).toBe(false)
  })
})

describe('safety-plc — M-out-of-N voting logic', () => {
  function pressureSensor(
    id: string,
    ip: string,
    maxValue = 250,
    modbusRegister = 0
  ): [string, DeviceOverrides] {
    return [
      id,
      {
        category: 'smart-sensor',
        ipAddress: ip,
        sensor: {
          kind: 'pressure',
          waveform: 'sine',
          minValue: 0,
          maxValue,
          units: 'psi',
          noisePercent: 3,
          modbusRegister
        }
      }
    ]
  }

  it('injects SIS_MBCONFIG_B64 with one device block per wired sensor', () => {
    const scenario = makeScenario([
      [
        'sis-1',
        { category: 'safety-plc', ipAddress: '10.200.10.10', safetyPlc: { votingConfig: '2oo3' } }
      ],
      pressureSensor('p1', '10.200.10.21'),
      pressureSensor('p2', '10.200.10.22'),
      pressureSensor('p3', '10.200.10.23')
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'sis-1', target: 'p1', data: { protocol: 'modbus-tcp' } },
      { id: 'e2', source: 'sis-1', target: 'p2', data: { protocol: 'modbus-tcp' } },
      { id: 'e3', source: 'sis-1', target: 'p3', data: { protocol: 'modbus-tcp' } }
    ]
    const env = gen(scenario).services['sis-1'].environment ?? []
    const b64 = env.find(v => v.startsWith('SIS_MBCONFIG_B64='))?.slice('SIS_MBCONFIG_B64='.length)
    expect(b64).toBeDefined()
    const mbconfig = Buffer.from(b64!, 'base64').toString()
    expect(mbconfig).toContain('Num_Devices = "3"')
    expect(mbconfig).toContain('device0.address = "10.200.10.21"')
    expect(mbconfig).toContain('device1.address = "10.200.10.22"')
    expect(mbconfig).toContain('device2.address = "10.200.10.23"')
    // Read-only voting inputs — no coil writes back to the sensors.
    expect(mbconfig).toContain('device0.Coils_Size = "0"')
    expect(mbconfig).toContain('device0.Holding_Registers_Read_Size = "1"')
  })

  it('generates real 2-out-of-3 voting ST logic, not a scaffold', () => {
    const scenario = makeScenario([
      [
        'sis-1',
        { category: 'safety-plc', ipAddress: '10.200.10.10', safetyPlc: { votingConfig: '2oo3' } }
      ],
      pressureSensor('p1', '10.200.10.21', 250),
      pressureSensor('p2', '10.200.10.22', 250),
      pressureSensor('p3', '10.200.10.23', 250)
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'sis-1', target: 'p1', data: { protocol: 'modbus-tcp' } },
      { id: 'e2', source: 'sis-1', target: 'p2', data: { protocol: 'modbus-tcp' } },
      { id: 'e3', source: 'sis-1', target: 'p3', data: { protocol: 'modbus-tcp' } }
    ]
    const env = gen(scenario).services['sis-1'].environment ?? []
    const b64 = env
      .find(v => v.startsWith('INITIAL_PROGRAM_B64='))
      ?.slice('INITIAL_PROGRAM_B64='.length)
    const st = Buffer.from(b64!, 'base64').toString()
    expect(st).toContain('sensor_0 AT %IW100 : INT')
    expect(st).toContain('sensor_1 AT %IW101 : INT')
    expect(st).toContain('sensor_2 AT %IW102 : INT')
    // 80% of maxValue 250 = 200 psi, x10 fixed-point on the wire = 2000.
    expect(st).toContain('IF sensor_0 > 2000 THEN vote_count := vote_count + 1;')
    expect(st).toContain('IF vote_count >= 2 THEN')
    expect(st).toContain('trip_relay := FALSE;')
  })

  it('clamps the vote threshold to the actual wired sensor count when fewer are connected than declared', () => {
    const scenario = makeScenario([
      [
        'sis-1',
        { category: 'safety-plc', ipAddress: '10.200.10.10', safetyPlc: { votingConfig: '2oo3' } }
      ],
      pressureSensor('p1', '10.200.10.21')
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'sis-1', target: 'p1', data: { protocol: 'modbus-tcp' } }
    ]
    const env = gen(scenario).services['sis-1'].environment ?? []
    const b64 = env
      .find(v => v.startsWith('INITIAL_PROGRAM_B64='))
      ?.slice('INITIAL_PROGRAM_B64='.length)
    const st = Buffer.from(b64!, 'base64').toString()
    // votingConfig declares 2oo3, but only 1 sensor is wired — clamp to 1oo1.
    expect(st).toContain('IF vote_count >= 1 THEN')
    expect(st).not.toContain('sensor_1')

    const mbB64 = env
      .find(v => v.startsWith('SIS_MBCONFIG_B64='))
      ?.slice('SIS_MBCONFIG_B64='.length)
    expect(Buffer.from(mbB64!, 'base64').toString()).toContain('Num_Devices = "1"')
  })

  it('falls back to the generic spare-coil scaffold when no sensors are wired', () => {
    const compose = gen(
      makeScenario([
        [
          'sis-1',
          { category: 'safety-plc', ipAddress: '10.200.10.10', safetyPlc: { votingConfig: '2oo3' } }
        ]
      ])
    )
    const env = compose.services['sis-1'].environment ?? []
    expect(env.some(v => v.startsWith('SIS_MBCONFIG_B64'))).toBe(false)
    const b64 = env
      .find(v => v.startsWith('INITIAL_PROGRAM_B64='))
      ?.slice('INITIAL_PROGRAM_B64='.length)
    expect(Buffer.from(b64!, 'base64').toString()).toContain('spare_0')
  })

  it('still injects SIS_MBCONFIG_B64 for a wired safety-plc even when it has an authored plcProgram', () => {
    // Matches ICS_Lab_04.otflab's actual sis-1: authored passthrough program,
    // one pressure sensor wired. The authored ST wins for INITIAL_PROGRAM_B64
    // (unaffected), but the sensor is still polled since wiring and program
    // choice are independent concerns.
    const authoredSt = Buffer.from('PROGRAM main\nEND_PROGRAM\n', 'utf8').toString('base64')
    const scenario = makeScenario([
      [
        'sis-1',
        {
          category: 'safety-plc',
          ipAddress: '10.200.10.10',
          safetyPlc: { votingConfig: '2oo3' },
          plcProgram: { language: 'st', source: authoredSt, variables: [] }
        }
      ],
      pressureSensor('p1', '10.200.10.21')
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'sis-1', target: 'p1', data: { protocol: 'modbus-tcp' } }
    ]
    const env = gen(scenario).services['sis-1'].environment ?? []
    const programB64 = env
      .find(v => v.startsWith('INITIAL_PROGRAM_B64='))
      ?.slice('INITIAL_PROGRAM_B64='.length)
    expect(programB64).toBe(authoredSt)
    expect(env.some(v => v.startsWith('SIS_MBCONFIG_B64'))).toBe(true)
  })
})

describe('batch-controller — ISA-88 phase sequencer', () => {
  function batchScenario(
    batchOverrides: Record<string, unknown> = {},
    reactorOverrides: Record<string, unknown> = {}
  ) {
    const scenario = makeScenario([
      [
        'batch-1',
        {
          category: 'batch-controller',
          ipAddress: '10.200.10.10',
          batch: {
            chargeTargetPct: 80,
            heatSetpointC: 70,
            reactHoldSec: 60,
            coolSetpointC: 30,
            dischargeTargetPct: 5,
            ...batchOverrides
          }
        }
      ],
      [
        'reactor-1',
        {
          category: 'process-unit',
          ipAddress: '10.200.10.20',
          processUnit: {
            processType: 'batch-reactor',
            tankVolumeL: 1000,
            tankAreaM2: 1.0,
            ...reactorOverrides
          }
        }
      ]
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'batch-1', target: 'reactor-1', data: { protocol: 'modbus-tcp' } }
    ]
    return scenario
  }

  it('injects PROCESS_SIM_IP for a batch-controller wired to a batch-reactor', () => {
    const env = gen(batchScenario()).services['batch-1'].environment ?? []
    expect(env).toContain('PROCESS_SIM_IP=10.200.10.20')
  })

  it('generates real ISA-88 phase-sequencer ST, not a scaffold', () => {
    const env = gen(batchScenario()).services['batch-1'].environment ?? []
    const b64 = env
      .find(v => v.startsWith('INITIAL_PROGRAM_B64='))
      ?.slice('INITIAL_PROGRAM_B64='.length)
    const st = Buffer.from(b64!, 'base64').toString()
    expect(st).toContain('level_pv AT %IW100 : INT')
    expect(st).toContain('temp_pv AT %IW104 : INT')
    expect(st).toContain('batch_state AT %QW0 : INT')
    expect(st).toContain('current_phase AT %QW1 : INT')
    // 80% of a 1000L/1.0m² vessel = 0.80 m level, ×100 fixed-point = 80.
    expect(st).toContain('IF level_pv >= 80 THEN current_phase := 2;')
    // 70.0°C heat setpoint, ×10 fixed-point = 700.
    expect(st).toContain('IF temp_pv >= 700 THEN current_phase := 3;')
    // 60s hold at a fixed T#100ms scan = 600 ticks.
    expect(st).toContain('IF react_ticks >= 600 THEN current_phase := 4;')
    // 30.0°C cool setpoint, ×10 fixed-point = 300.
    expect(st).toContain('IF temp_pv <= 300 THEN current_phase := 5;')
    // 5% of a 1000L/1.0m² vessel = 0.05 m level, ×100 fixed-point = 5.
    expect(st).toContain('IF level_pv <= 5 THEN')
  })

  it('injects BATCH_* informational env vars when device.batch is set', () => {
    const env =
      gen(batchScenario({ recipeName: 'Product A' })).services['batch-1'].environment ?? []
    expect(env).toContain('BATCH_RECIPE_NAME=Product A')
    expect(env).toContain('BATCH_CHARGE_TARGET_PCT=80')
    expect(env).toContain('BATCH_HEAT_SETPOINT_C=70')
  })

  it('falls back to the generic actuator scaffold when not wired to a batch-reactor', () => {
    const compose = gen(
      makeScenario([
        ['batch-1', { category: 'batch-controller', ipAddress: '10.200.10.10', batch: {} }]
      ])
    )
    const env = compose.services['batch-1'].environment ?? []
    const b64 = env
      .find(v => v.startsWith('INITIAL_PROGRAM_B64='))
      ?.slice('INITIAL_PROGRAM_B64='.length)
    expect(Buffer.from(b64!, 'base64').toString()).toContain('spare_0')
  })

  it('does not generate batch ST for a batch-controller wired to a non-batch process-unit', () => {
    const scenario = makeScenario([
      ['batch-1', { category: 'batch-controller', ipAddress: '10.200.10.10', batch: {} }],
      [
        'tank-1',
        {
          category: 'process-unit',
          ipAddress: '10.200.10.20',
          processUnit: { processType: 'water-tank' }
        }
      ]
    ])
    scenario.visual.edges = [
      { id: 'e1', source: 'batch-1', target: 'tank-1', data: { protocol: 'modbus-tcp' } }
    ]
    const env = gen(scenario).services['batch-1'].environment ?? []
    const b64 = env
      .find(v => v.startsWith('INITIAL_PROGRAM_B64='))
      ?.slice('INITIAL_PROGRAM_B64='.length)
    // Still gets PROCESS_SIM_IP (plain-PLC-style wiring), but the generic
    // actuator scaffold, not the batch phase-sequencer.
    expect(env).toContain('PROCESS_SIM_IP=10.200.10.20')
    expect(Buffer.from(b64!, 'base64').toString()).toContain('spare_0')
  })
})

// ── DNS device env vars ───────────────────────────────────────────────────────

describe('DNS device environment variable injection', () => {
  it('injects DNS_DOMAIN when device.dns.domain is set', () => {
    const compose = gen(
      makeScenario([
        [
          'dns-1',
          {
            category: 'dns-server',
            ipAddress: '10.200.50.10',
            dns: { domain: 'ics-lab.local', webServerIp: '', upstream: '8.8.8.8' }
          }
        ]
      ])
    )
    const env = compose.services['dns-1'].environment ?? []
    expect(env).toContain('DNS_DOMAIN=ics-lab.local')
  })

  it('injects WEB_SERVER_IP when device.dns.webServerIp is set', () => {
    const compose = gen(
      makeScenario([
        [
          'dns-1',
          {
            category: 'dns-server',
            ipAddress: '10.200.50.10',
            dns: { domain: 'test.com', webServerIp: '10.200.50.11', upstream: '' }
          }
        ]
      ])
    )
    const env = compose.services['dns-1'].environment ?? []
    expect(env).toContain('WEB_SERVER_IP=10.200.50.11')
  })

  it('injects DNS_UPSTREAM=8.8.8.8 when upstream is "8.8.8.8"', () => {
    const compose = gen(
      makeScenario([
        [
          'dns-1',
          {
            category: 'dns-server',
            ipAddress: '10.200.50.10',
            dns: { domain: '', webServerIp: '', upstream: '8.8.8.8' }
          }
        ]
      ])
    )
    const env = compose.services['dns-1'].environment ?? []
    expect(env).toContain('DNS_UPSTREAM=8.8.8.8')
  })

  it('injects DNS_UPSTREAM= (empty) when upstream is "" — triggers air-gapped mode', () => {
    // Empty string upstream is meaningful (air-gapped DNS — no public forwarding).
    // The inject must use !== undefined so "" is preserved, not skipped.
    const compose = gen(
      makeScenario([
        [
          'dns-1',
          {
            category: 'dns-server',
            ipAddress: '10.200.50.10',
            dns: { domain: '', webServerIp: '', upstream: '' }
          }
        ]
      ])
    )
    const env = compose.services['dns-1'].environment ?? []
    expect(env).toContain('DNS_UPSTREAM=')
  })

  it('does NOT inject DNS_UPSTREAM when upstream is undefined', () => {
    const compose = gen(
      makeScenario([
        [
          'dns-1',
          {
            category: 'dns-server',
            ipAddress: '10.200.50.10',
            dns: { domain: '', webServerIp: '' }
          }
        ]
      ])
    )
    const env = compose.services['dns-1'].environment ?? []
    expect(env.some(v => v.startsWith('DNS_UPSTREAM'))).toBe(false)
  })
})

describe('domain-controller — real Samba4 AD device', () => {
  it('gives domain-controller the otforge-dc image — a real container, not the alpine stub', () => {
    const compose = gen(
      makeScenario([['dc-1', { category: 'domain-controller', ipAddress: '10.200.40.10' }]])
    )
    expect(compose.services['dc-1']).toBeDefined()
    expect(compose.services['dc-1'].image).toBe('ghcr.io/iburres/otforge-dc:latest')
  })

  it('assigns the 256m/0.5 resource limit to domain-controller', () => {
    const compose = gen(
      makeScenario([['dc-1', { category: 'domain-controller', ipAddress: '10.200.40.10' }]])
    )
    expect(compose.services['dc-1'].deploy.resources.limits.memory).toBe('256m')
    expect(compose.services['dc-1'].deploy.resources.limits.cpus).toBe('0.5')
  })

  it('injects AD_DOMAIN when device.domainController.domainName is set', () => {
    const compose = gen(
      makeScenario([
        [
          'dc-1',
          {
            category: 'domain-controller',
            ipAddress: '10.200.40.10',
            domainController: { domainName: 'CONTOSO.LOCAL' }
          }
        ]
      ])
    )
    const env = compose.services['dc-1'].environment ?? []
    expect(env).toContain('AD_DOMAIN=CONTOSO.LOCAL')
  })

  it('injects AD_NETBIOS when device.domainController.netbiosName is set', () => {
    const compose = gen(
      makeScenario([
        [
          'dc-1',
          {
            category: 'domain-controller',
            ipAddress: '10.200.40.10',
            domainController: { netbiosName: 'CONTOSO' }
          }
        ]
      ])
    )
    const env = compose.services['dc-1'].environment ?? []
    expect(env).toContain('AD_NETBIOS=CONTOSO')
  })

  it('injects AD_ADMIN_PASSWORD when device.domainController.adminPassword is set', () => {
    const compose = gen(
      makeScenario([
        [
          'dc-1',
          {
            category: 'domain-controller',
            ipAddress: '10.200.40.10',
            domainController: { adminPassword: 'Test123!Passw0rd' }
          }
        ]
      ])
    )
    const env = compose.services['dc-1'].environment ?? []
    expect(env).toContain('AD_ADMIN_PASSWORD=Test123!Passw0rd')
  })

  it('omits AD_DOMAIN/AD_NETBIOS/AD_ADMIN_PASSWORD entirely when device.domainController is unset', () => {
    const compose = gen(
      makeScenario([['dc-1', { category: 'domain-controller', ipAddress: '10.200.40.10' }]])
    )
    const env = compose.services['dc-1'].environment ?? []
    expect(env.some(v => v.startsWith('AD_DOMAIN'))).toBe(false)
    expect(env.some(v => v.startsWith('AD_NETBIOS'))).toBe(false)
    expect(env.some(v => v.startsWith('AD_ADMIN_PASSWORD'))).toBe(false)
  })
})

// ── Process unit env vars (pipeline + generator) ──────────────────────────────

describe('process unit environment variable injection', () => {
  it('injects PIPELINE_VOLUME_L and PIPELINE_PUMP_MAX_LPM for pipeline units', () => {
    const compose = gen(
      makeScenario([
        [
          'pipe-1',
          {
            category: 'process-unit',
            ipAddress: '10.200.10.20',
            processUnit: {
              processType: 'pipeline',
              pipelineVolumeL: 5000,
              pipelinePumpMaxLpm: 300
            }
          }
        ]
      ])
    )
    const env = compose.services['pipe-1'].environment ?? []
    expect(env).toContain('PROCESS_TYPE=pipeline')
    expect(env).toContain('PIPELINE_VOLUME_L=5000')
    expect(env).toContain('PIPELINE_PUMP_MAX_LPM=300')
  })

  it('injects GENERATOR_RATED_MW, GENERATOR_INERTIA_H, GENERATOR_FREQ_BASE for generator units', () => {
    const compose = gen(
      makeScenario([
        [
          'gen-1',
          {
            category: 'process-unit',
            ipAddress: '10.200.10.20',
            processUnit: {
              processType: 'generator',
              generatorRatedMw: 100,
              generatorInertiaH: 5,
              generatorFreqBase: 60
            }
          }
        ]
      ])
    )
    const env = compose.services['gen-1'].environment ?? []
    expect(env).toContain('GENERATOR_RATED_MW=100')
    expect(env).toContain('GENERATOR_INERTIA_H=5')
    expect(env).toContain('GENERATOR_FREQ_BASE=60')
  })

  it('omits optional process unit vars when not set', () => {
    const compose = gen(
      makeScenario([
        [
          'tank-1',
          {
            category: 'process-unit',
            ipAddress: '10.200.10.20',
            processUnit: { processType: 'water-tank' }
          }
        ]
      ])
    )
    const env = compose.services['tank-1'].environment ?? []
    expect(env).toContain('PROCESS_TYPE=water-tank')
    expect(env.some(v => v.startsWith('PIPELINE_'))).toBe(false)
    expect(env.some(v => v.startsWith('GENERATOR_'))).toBe(false)
  })

  // Reproducibility controls: an evaluation scenario pins them, a teaching
  // scenario leaves them out so the container keeps its own defaults (an unset
  // SIM_SEED means the simulator draws and logs its own seed).
  it('injects SIM_SEED and SIM_REALTIME=0 for a pinned fast-forward unit', () => {
    const compose = gen(
      makeScenario([
        [
          'tank-1',
          {
            category: 'process-unit',
            ipAddress: '10.200.10.20',
            processUnit: { processType: 'water-tank', simSeed: 42, simRealtime: false }
          }
        ]
      ])
    )
    const env = compose.services['tank-1'].environment ?? []
    expect(env).toContain('SIM_SEED=42')
    expect(env).toContain('SIM_REALTIME=0')
  })

  it('emits SIM_REALTIME=1 when real-time pacing is set explicitly', () => {
    const compose = gen(
      makeScenario([
        [
          'tank-1',
          {
            category: 'process-unit',
            ipAddress: '10.200.10.20',
            processUnit: { processType: 'water-tank', simRealtime: true }
          }
        ]
      ])
    )
    const env = compose.services['tank-1'].environment ?? []
    expect(env).toContain('SIM_REALTIME=1')
  })

  // seed 0 is falsy but a perfectly valid seed -- it must survive the emit.
  it('injects SIM_SEED=0 rather than dropping it as falsy', () => {
    const compose = gen(
      makeScenario([
        [
          'tank-1',
          {
            category: 'process-unit',
            ipAddress: '10.200.10.20',
            processUnit: { processType: 'water-tank', simSeed: 0 }
          }
        ]
      ])
    )
    const env = compose.services['tank-1'].environment ?? []
    expect(env).toContain('SIM_SEED=0')
  })

  it('omits SIM_SEED and SIM_REALTIME when not set', () => {
    const compose = gen(
      makeScenario([
        [
          'tank-1',
          {
            category: 'process-unit',
            ipAddress: '10.200.10.20',
            processUnit: { processType: 'water-tank' }
          }
        ]
      ])
    )
    const env = compose.services['tank-1'].environment ?? []
    expect(env.some(v => v.startsWith('SIM_SEED'))).toBe(false)
    expect(env.some(v => v.startsWith('SIM_REALTIME'))).toBe(false)
  })
})

// ── S7 / IEC 104 / BACnet env vars ───────────────────────────────────────────

describe('legacy protocol environment variable injection', () => {
  it('injects S7_DEVICE_TYPE and S7_PORT for S7 devices', () => {
    const compose = gen(
      makeScenario([
        [
          's7-1',
          {
            category: 'legacy-plc',
            ipAddress: '10.200.10.10',
            s7: { deviceType: '300', rack: 0, slot: 2, port: 102 }
          }
        ]
      ])
    )
    const env = compose.services['s7-1'].environment ?? []
    expect(env).toContain('S7_DEVICE_TYPE=300')
    expect(env).toContain('S7_PORT=102')
  })

  it('injects IEC104_COMMON_ADDRESS and IEC104_PORT for IEC 104 RTU devices', () => {
    const compose = gen(
      makeScenario([
        [
          'rtu-1',
          {
            category: 'iec104-rtu',
            ipAddress: '10.200.10.10',
            iec104: { commonAddress: 7, port: 2404 }
          }
        ]
      ])
    )
    const env = compose.services['rtu-1'].environment ?? []
    expect(env).toContain('IEC104_COMMON_ADDRESS=7')
    expect(env).toContain('IEC104_PORT=2404')
  })

  it('injects BACNET_DEVICE_INSTANCE and BACNET_PORT for BACnet devices', () => {
    const compose = gen(
      makeScenario([
        [
          'bacnet-1',
          {
            category: 'sensor',
            ipAddress: '10.200.10.10',
            bacnet: { deviceInstance: 1001, port: 47808 }
          }
        ]
      ])
    )
    const env = compose.services['bacnet-1'].environment ?? []
    expect(env).toContain('BACNET_DEVICE_INSTANCE=1001')
    expect(env).toContain('BACNET_PORT=47808')
  })

  it('uses default BACnet port 47808 when port is not specified', () => {
    const compose = gen(
      makeScenario([
        [
          'bacnet-1',
          {
            category: 'sensor',
            ipAddress: '10.200.10.10',
            bacnet: { deviceInstance: 42 }
          }
        ]
      ])
    )
    const env = compose.services['bacnet-1'].environment ?? []
    expect(env).toContain('BACNET_PORT=47808')
  })

  it('injects BACNET_KIND for a building-automation equipment kind', () => {
    const compose = gen(
      makeScenario([
        [
          'ahu-1',
          {
            category: 'sensor',
            ipAddress: '10.200.10.10',
            bacnet: { deviceInstance: 1002, kind: 'ahu' }
          }
        ]
      ])
    )
    const env = compose.services['ahu-1'].environment ?? []
    expect(env).toContain('BACNET_KIND=ahu')
  })

  it('defaults BACNET_KIND to generic when kind is not specified (pre-existing scenarios)', () => {
    const compose = gen(
      makeScenario([
        [
          'bacnet-1',
          {
            category: 'sensor',
            ipAddress: '10.200.10.10',
            bacnet: { deviceInstance: 1001 }
          }
        ]
      ])
    )
    const env = compose.services['bacnet-1'].environment ?? []
    expect(env).toContain('BACNET_KIND=generic')
  })
})

// ── WS_PLC_WEBUIS workstation + PLC injection ─────────────────────────────────

describe('WS_PLC_WEBUIS injection', () => {
  it('injects WS_PLC_WEBUIS into workstation env when a PLC is in the scenario', () => {
    const compose = gen(
      makeScenario([
        ['ws-1', { category: 'engineering-workstation', ipAddress: '10.200.20.50' }],
        ['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]
      ])
    )
    const env = compose.services['ws-1'].environment ?? []
    const entry = env.find(v => v.startsWith('WS_PLC_WEBUIS='))
    expect(entry).toBeDefined()
    expect(entry).toContain('plc-1|http://10.200.10.10:8080')
  })

  it('includes all PLCs in WS_PLC_WEBUIS when multiple PLCs are present', () => {
    const compose = gen(
      makeScenario([
        ['ws-1', { category: 'engineering-workstation', ipAddress: '10.200.20.50' }],
        ['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }],
        ['plc-2', { category: 'plc', ipAddress: '10.200.10.11' }]
      ])
    )
    const env = compose.services['ws-1'].environment ?? []
    const entry = env.find(v => v.startsWith('WS_PLC_WEBUIS='))
    expect(entry).toBeDefined()
    expect(entry).toContain('plc-1|http://10.200.10.10:8080')
    expect(entry).toContain('plc-2|http://10.200.10.11:8080')
  })

  it('does NOT inject WS_PLC_WEBUIS when no PLCs are in the scenario', () => {
    const compose = gen(
      makeScenario([
        ['ws-1', { category: 'engineering-workstation', ipAddress: '10.200.20.50' }],
        ['rtu-1', { category: 'rtu', ipAddress: '10.200.10.10' }]
      ])
    )
    const env = compose.services['ws-1'].environment ?? []
    expect(env.some(v => v.startsWith('WS_PLC_WEBUIS='))).toBe(false)
  })

  it('injects WS_PLC_WEBUIS into all workstations when multiple are present', () => {
    const compose = gen(
      makeScenario([
        ['ws-1', { category: 'engineering-workstation', ipAddress: '10.200.20.50' }],
        ['ws-2', { category: 'engineering-workstation', ipAddress: '10.200.20.51' }],
        ['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]
      ])
    )
    for (const wsKey of ['ws-1', 'ws-2']) {
      const env = compose.services[wsKey].environment ?? []
      expect(env.some(v => v.startsWith('WS_PLC_WEBUIS='))).toBe(true)
    }
  })
})

// ── Fixed infrastructure services ─────────────────────────────────────────────

describe('fixed infrastructure services', () => {
  // Infrastructure runs in every simulation regardless of scenario contents.
  // Using a single-sensor scenario as the minimal base.
  const infraScenario = makeScenario([['s1', { category: 'sensor', ipAddress: '10.200.10.10' }]])

  it('always includes Suricata IDS/IPS', () => {
    expect(gen(infraScenario).services).toHaveProperty('suricata')
  })

  it('always includes Zeek passive network analysis', () => {
    expect(gen(infraScenario).services).toHaveProperty('zeek')
  })

  it('always includes InfluxDB for the process historian', () => {
    expect(gen(infraScenario).services).toHaveProperty('influxdb')
  })

  it('always includes Loki for log aggregation', () => {
    expect(gen(infraScenario).services).toHaveProperty('loki')
  })

  it('always includes Grafana for dashboards', () => {
    expect(gen(infraScenario).services).toHaveProperty('grafana')
  })

  it('always includes FUXA for the HMI', () => {
    expect(gen(infraScenario).services).toHaveProperty('fuxa')
  })

  it('creates named volumes for all infrastructure services that need persistence', () => {
    const compose = gen(infraScenario, 'my-proj')
    expect(compose.volumes).toHaveProperty('my-proj-suricata-logs')
    expect(compose.volumes).toHaveProperty('my-proj-zeek-logs')
    expect(compose.volumes).toHaveProperty('my-proj-influxdb-data')
    expect(compose.volumes).toHaveProperty('my-proj-grafana-data')
    expect(compose.volumes).toHaveProperty('my-proj-fuxa-data')
  })

  it('does NOT create a persistent volume for Loki (storage is ephemeral by design)', () => {
    // Loki storage is deliberately ephemeral: a persisted loki-data volume, once
    // the rolling grafana/loki image drifted to 3.7.4, hung at /ready=503 because
    // the new version could not recover the old WAL — silently breaking the whole
    // Suricata/Zeek -> Grafana pipeline in class. A training SIEM starts clean each
    // run, so Loki must have no named volume and no /loki mount. See compose-generator.ts.
    const compose = gen(infraScenario, 'my-proj')
    expect(compose.volumes).not.toHaveProperty('my-proj-loki-data')
    expect(compose.services['loki'].volumes).toBeUndefined()
  })

  it('places infrastructure services on control-net (Level 3 — Control Center)', () => {
    const compose = gen(infraScenario)
    // InfluxDB, Loki, Grafana, FUXA all live in the Control Center zone (L3)
    expect(compose.services['influxdb'].networks).toHaveProperty('control-net')
    expect(compose.services['loki'].networks).toHaveProperty('control-net')
    expect(compose.services['grafana'].networks).toHaveProperty('control-net')
    expect(compose.services['fuxa'].networks).toHaveProperty('control-net')
  })

  it('grants Suricata NET_ADMIN + NET_RAW for AF_PACKET raw socket capture', () => {
    const compose = gen(infraScenario)
    expect(compose.services['suricata'].cap_add).toContain('NET_ADMIN')
    expect(compose.services['suricata'].cap_add).toContain('NET_RAW')
  })

  it('runs Suricata in host network mode for AF_PACKET bridge interface access', () => {
    const compose = gen(infraScenario)
    // Suricata uses network_mode: 'host' so it can open AF_PACKET sockets on the
    // br-XXXX Docker bridge interfaces — per-network IP assignments are not used.
    expect(compose.services['suricata'].network_mode).toBe('host')
  })

  it('runs Zeek in host network mode so it sees all simulation bridge interfaces', () => {
    const compose = gen(infraScenario)
    // Zeek uses network_mode: 'host', same as Suricata — a container's own veth in
    // promiscuous mode does not see sibling-container unicast traffic, only the
    // host-side br-XXXX bridge does. No per-network IP assignments are used.
    expect(compose.services['zeek'].network_mode).toBe('host')
    expect(compose.services['zeek'].networks).toBeUndefined()
  })
})

// ── PLC ↔ process-unit wiring ─────────────────────────────────────────────────

/**
 * PROCESS_SIM_IP is what tells OpenPLC's Modbus-master engine which physics
 * simulator to poll and drive. Without it the PLC comes up with no mbconfig.cfg,
 * the simulator's coils stay at their zero-init, and the modeled process never
 * responds to the controller — a silent failure that looks like a working lab.
 *
 * Two wiring styles must both resolve:
 *   - a direct PLC↔process-unit edge, and
 *   - a coilSource edge, where the controlling PLC is named inside
 *     edge.data.coilSource and the edge itself is drawn through a visual-only
 *     glyph (a pump/valve/sensor node with no entry in devices.devices).
 *
 * The coilSource style regressed: a both-endpoints-must-resolve guard ran before
 * the coilSource branch and discarded every such edge.
 */
describe('PLC to process-unit wiring', () => {
  /** Scenario with a PLC and a water tank, plus the edges the caller supplies. */
  function wiringScenario(edges: OTForgeScenario['visual']['edges']): OTForgeScenario {
    const sc = makeScenario([
      ['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }],
      [
        'process-unit-1',
        {
          category: 'process-unit',
          ipAddress: '10.200.10.20',
          processUnit: { processType: 'water-tank' }
        }
      ]
    ])
    sc.visual.edges = edges
    return sc
  }

  /** Builds one canvas edge, optionally carrying a coilSource binding. */
  function edge(
    id: string,
    source: string,
    target: string,
    coilSource?: { nodeId: string; coilIndex: number }
  ): OTForgeScenario['visual']['edges'][number] {
    return {
      id,
      source,
      target,
      data: { protocol: 'modbus-tcp', ...(coilSource && { coilSource }) }
    }
  }

  /** Reads the PROCESS_SIM_IP value out of a generated PLC service, if present. */
  function simIp(compose: ParsedCompose, service = 'plc-1'): string | undefined {
    const env = compose.services[service]?.environment ?? []
    return env.find(e => e.startsWith('PROCESS_SIM_IP='))?.split('=')[1]
  }

  it('wires a direct PLC to process-unit edge', () => {
    const compose = gen(wiringScenario([edge('e1', 'plc-1', 'process-unit-1')]))
    expect(simIp(compose)).toBe('10.200.10.20')
  })

  it('wires a direct edge drawn in the reverse direction', () => {
    const compose = gen(wiringScenario([edge('e1', 'process-unit-1', 'plc-1')]))
    expect(simIp(compose)).toBe('10.200.10.20')
  })

  it('wires a coilSource edge routed through a visual-only pump glyph', () => {
    // inlet-pump-1 exists only on the canvas — it has no devices.devices entry.
    // This is the exact shape ICS_Lab_01 uses, and the shape that regressed.
    const compose = gen(
      wiringScenario([
        edge('e1', 'inlet-pump-1', 'process-unit-1', { nodeId: 'plc-1', coilIndex: 0 })
      ])
    )
    expect(simIp(compose)).toBe('10.200.10.20')
  })

  it('wires a coilSource edge when the glyph is the target rather than the source', () => {
    const compose = gen(
      wiringScenario([
        edge('e1', 'process-unit-1', 'outlet-valve-1', { nodeId: 'plc-1', coilIndex: 1 })
      ])
    )
    expect(simIp(compose)).toBe('10.200.10.20')
  })

  it('ignores a coilSource edge naming a PLC that is not in the device map', () => {
    const compose = gen(
      wiringScenario([
        edge('e1', 'inlet-pump-1', 'process-unit-1', { nodeId: 'ghost-plc', coilIndex: 0 })
      ])
    )
    expect(simIp(compose)).toBeUndefined()
  })

  it('ignores a coilSource edge whose named source is not a controller', () => {
    // Pointing coilSource at the tank itself must not inject PROCESS_SIM_IP
    // into the process-unit's own container.
    const compose = gen(
      wiringScenario([
        edge('e1', 'inlet-pump-1', 'process-unit-1', { nodeId: 'process-unit-1', coilIndex: 0 })
      ])
    )
    expect(simIp(compose, 'process-unit-1')).toBeUndefined()
  })

  it('emits no PROCESS_SIM_IP when the PLC is not wired to any process-unit', () => {
    const compose = gen(wiringScenario([]))
    expect(simIp(compose)).toBeUndefined()
  })

  it('leaves an edge between two visual-only glyphs alone', () => {
    const compose = gen(
      wiringScenario([
        edge('e1', 'inlet-pump-1', 'level-sensor-1', { nodeId: 'plc-1', coilIndex: 0 })
      ])
    )
    expect(simIp(compose)).toBeUndefined()
  })
})
