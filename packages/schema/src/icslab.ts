// .otflab scenario file format — the canonical exchange format for OTForge scenarios.
// All four layers are present in unlocked scenarios. Locked scenarios omit visual/security
// layer details to prevent topology extraction by students.

export type Sector =
  | 'oil-gas'
  | 'power-generation'
  | 'power-distribution'
  | 'water-treatment'
  | 'chemical-batch'
  | 'automotive'
  | 'building-automation'
  | 'generic'

export type Protocol =
  | 'modbus-tcp'
  | 'modbus-rtu'
  | 'modbus-ascii'
  | 'dnp3'
  | 'opc-ua'
  | 'bacnet'
  | 'ethernet-ip'
  | 'iec61850'
  | 'profinet' // PROFINET DCP (Discovery and Configuration Protocol) — device discovery/naming/IP assignment over raw Ethernet, EtherType 0x8892
  | 's7comm' // Siemens S7 Communication (S7-300/400/1200/1500, port 102)
  | 'iec-104' // IEC 60870-5-104 telecontrol protocol (port 2404)
  | 'mqtt' // Message Queuing Telemetry Transport — IIoT sensors, cloud gateways, broker-based pub/sub
  | 'c37118' // IEEE C37.118 synchrophasor protocol — PMU/PDC wide-area grid monitoring (port 4712)
  | 'ldap' // Lightweight Directory Access Protocol — Active Directory bind/search (port 389)
  | 'kerberos' // Kerberos network authentication (AS-REQ/TGT, port 88) — Active Directory domain auth
  | 'smb' // Server Message Block file/print sharing — Active Directory domain (port 445)
  | 'none'

/**
 * Physical cable / media types used in ICS and IT network infrastructure.
 *
 * Organized by media family:
 *   Ethernet twisted-pair — cat5e (100 Mbps), cat6 (1 Gbps), cat6a (10 Gbps)
 *   Fiber optic            — smf (single-mode, long-haul), mmf (multi-mode, in-building)
 *   Wireless               — wifi (802.11 a/b/g/n/ac/ax; WirelessHART; ISA100)
 *   Serial                 — rs232 (point-to-point console), rs485 (multi-drop field bus)
 *   Storage                — sata (Serial ATA; direct-attached storage, server disk buses)
 *   Power                  — ac (mains power), dc (24 VDC instrument power)
 *
 * Cable type is OPTIONAL on canvas edges; omitting it means the physical medium
 * is not specified. When present, connectionRules enforces that:
 *   1. Both endpoint device categories can physically terminate that medium.
 *   2. The chosen application protocol is compatible with that medium
 *      (e.g., Modbus RTU only runs on RS-232/RS-485; Modbus TCP requires Ethernet/WiFi).
 */
export type CableType =
  | 'cat5e' // Ethernet Cat5e — 100 Mbps, twisted pair, typical OT field network
  | 'cat6' // Ethernet Cat6  — 1 Gbps, twisted pair, control center / enterprise
  | 'cat6a' // Ethernet Cat6a — 10 Gbps, twisted pair, data center / spine links
  | 'smf' // Single-Mode Fiber — long-distance backbone (inter-building, inter-zone)
  | 'mmf' // Multi-Mode Fiber  — short-distance fiber (within substation / building)
  | 'wifi' // Wireless 802.11 / WirelessHART / ISA100 — mobile HMI, wireless field devices
  | 'rs232' // Serial RS-232 — point-to-point console / programming cable
  | 'rs485' // Serial RS-485 — multi-drop field bus, Modbus RTU / serial instruments
  | 'sata' // Serial ATA — direct-attached storage, server/historian disk interface
  | 'ac' // AC mains power cable
  | 'dc' // DC instrument power (24 VDC, loop-powered sensors and actuators)

/**
 * Network zones following the Purdue Reference Model (IEC 62443-3-2 / NIST SP 800-82).
 *   ot           — Levels 0–2:   Field devices — PLCs, RTUs, IEDs, sensors, actuators
 *   control      — Level 3:      Control Center/Processing LAN — HMIs, historians, app/db servers
 *   plant-dmz    — Level 3.5:    Plant DMZ — firewalls, IDS/IPS, jump hosts
 *   enterprise   — Level 4:      Enterprise Zone — domain controllers, business servers, desktops
 *   internet-dmz — Level 5:      Internet DMZ — email and internet-facing servers
 *   attacker     — Red Team:     Isolated attack machine subnet (not shown in Purdue layer tabs)
 */
export type NetworkZone =
  'ot' | 'control' | 'plant-dmz' | 'enterprise' | 'internet-dmz' | 'attacker'

export type DeviceCategory =
  // ── OT Process (Levels 0–2) ──────────────────────────────────────────────────
  | 'plc'
  | 'rtu'
  | 'ied' // Intelligent Electronic Device — DNP3 outstation (protection relay / bay controller)
  | 'iec61850-ied' // IEC 61850 IED — MMS server (substation automation: power gen + distribution)
  | 'ethernetip-adapter' // EtherNet/IP (CIP) remote I/O adapter — explicit messaging only, no Class 1 cyclic I/O
  | 'profinet-device' // PROFINET IO device — DCP discovery/naming/IP assignment only, no AR establishment or RT cyclic I/O
  | 'safety-plc' // Safety Instrumented System / Safety PLC (IEC 61511) — Triconex, Siemens Safety
  | 'dcs-controller' // Distributed Control System controller — Honeywell, Emerson DeltaV, ABB 800xA
  | 'batch-controller' // ISA-88 batch control — fixed 5-phase (charge/heat/react/cool/discharge) recipe engine
  | 'pmu' // Phasor Measurement Unit — real IEEE C37.118 synchrophasor protocol, polls a wired generator process-unit
  | 'legacy-plc' // Siemens S7-300/400/1200/1500 via S7comm (Phase 10)
  | 'iec104-rtu' // IEC 60870-5-104 RTU via conpot emulation (Phase 10)
  | 'process-unit' // Physics-simulated process unit: water tank, pipeline, generator (Phase 11)
  | 'sensor'
  | 'iiot-sensor' // IIoT wireless sensor node — WirelessHART, ISA100.11a, MQTT publisher
  | 'iot-gateway' // IIoT protocol gateway — Modbus-to-MQTT/REST bridge, edge aggregator
  | 'smart-sensor' // Configurable field sensor (pick `kind` in Properties Panel); real Modbus-backed container generates the waveform
  | 'smart-controller' // Configurable field controller/actuator (pick `kind` in Properties Panel); real Modbus-backed container
  // ── Control Center (Level 3) ─────────────────────────────────────────────────
  | 'hmi'
  | 'historian'
  | 'scada-server' // SCADA master station / polling engine — distinct from HMI operator console
  | 'application-server'
  | 'database-server'
  | 'engineering-workstation'
  // ── Plant DMZ (Level 3.5) ────────────────────────────────────────────────────
  | 'firewall'
  | 'ids-ips'
  | 'switch'
  | 'router'
  | 'jump-server' // Bastion host / jump server — hardened remote-access gateway into OT network
  | 'data-diode' // Unidirectional security gateway (Waterfall, Owl) — OT→IT data-only, no reverse path
  | 'wap' // Wireless Access Point — industrial 802.11, WirelessHART AP, mobile HMI uplink
  // ── Enterprise Zone (Level 4) ────────────────────────────────────────────────
  | 'domain-controller'
  | 'web-server'
  | 'business-server'
  | 'enterprise-desktop'
  // ── Internet DMZ (Level 5) ───────────────────────────────────────────────────
  | 'email-server'
  | 'internet-server'
  | 'dns-server' // Authoritative/recursive DNS server — meridian-process.com zone (Phase 12)
  | 'ip-camera' // Internet-facing IoT camera — weak default SSH credentials, commonly misconfigured as a dual-homed pivot into an internal zone
  // ── Red Team ─────────────────────────────────────────────────────────────────
  | 'attack-machine'

// ── Visual layer ─────────────────────────────────────────────────────────────

export interface CanvasPosition {
  x: number
  y: number
}

export interface CanvasNode {
  id: string
  type: string // matches DeviceTypeDefinition.id
  position: CanvasPosition
  data: {
    label: string
    zone: NetworkZone
  }
}

/**
 * Physical substance carried by a P&ID pipe edge on the OT Process canvas.
 *
 * Used to select the animated flow icon that travels along the pipe when a
 * coil-driven flow is active. 'none' (the default) falls back to the legacy
 * green-dash animation for backwards compatibility with existing scenarios.
 *
 *   electric  — electrical power lines (AC/DC bus, generator tie lines)
 *   water     — process water, cooling water, steam condensate
 *   gas       — natural gas, steam, pneumatic air (same icon, named by label)
 *   oil       — crude oil, refined product, hydraulic fluid
 *   chemical  — process chemicals, reagents, solvents
 *   none      — unspecified / backwards-compatible green-dash animation
 */
export type FluidType = 'electric' | 'water' | 'gas' | 'oil' | 'chemical' | 'none'

export interface CanvasEdge {
  id: string
  source: string // node id
  target: string // node id
  /**
   * Optional React Flow handle overrides. When set, these take precedence over the
   * automatic bestHandles() computation in scenarioToEdges so that specific edges can
   * be routed to a non-default side of a node (e.g., top/bottom arcs to avoid routing
   * through intermediate nodes). Must match the handle `id` props on DeviceNode
   * (s-top, s-bottom, s-left, s-right for source; t-top, t-bottom, t-left, t-right for target).
   */
  sourceHandle?: string
  targetHandle?: string
  data: {
    protocol: Protocol
    label?: string
    /**
     * Optional physical cable / media type for this connection.
     * When set, the canvas renders a second label chip on the edge showing the
     * cable type. connectionRules validates that the cable is appropriate for
     * the source and target device categories.
     * When absent, the physical medium is not specified (protocol-only view).
     */
    cableType?: CableType
    /**
     * Optional coil binding for OT-layer pipe flow animation.
     * When set, the SCADA canvas polls the named PLC coil at runtime and colors
     * the pipe edge green (flowing) or red (stopped) based on the coil state.
     */
    coilSource?: {
      /** nodeId of the PLC device in the scenario device map. */
      nodeId: string
      /** Zero-based Modbus coil address (FC01). */
      coilIndex: number
    }
    /**
     * Physical substance flowing through this pipe.
     * Selects the animated icon that travels along the edge when flowActive is true.
     * When absent or 'none', the legacy green-dash animation is used instead,
     * preserving full backwards compatibility with existing scenario files.
     */
    fluidType?: FluidType
  }
}

/**
 * A labeled, colored rectangular region overlaid on the canvas to indicate a
 * physical field site (local control room, remote pump station, substation, etc.).
 *
 * Site regions are purely visual — they do not affect simulation or Docker networking.
 * They render behind device nodes so RTUs and sensors can sit visually "inside" a site.
 *
 * Authors create them via the "Add Field Site" button in Author Mode and can:
 *   - Drag to reposition
 *   - Drag the resize handles to change dimensions
 *   - Edit the label inline on the canvas
 *   - Pick a border/fill color from the Properties Panel
 *
 * Students see the regions as read-only overlays that communicate the physical
 * layout of the ICS deployment (local vs. remote, which devices share a site).
 */
export interface SiteRegion {
  /** Unique identifier — used as the React Flow node ID. */
  id: string
  /** Human-readable name shown in the region header, e.g. "Remote Site 1". */
  label: string
  /**
   * CSS hex color for the border and semi-transparent fill tint.
   * Recommended: green/teal for local sites, amber/orange for remote sites.
   */
  color: string
  /** Which Purdue layer this region belongs to — filtered same as device nodes. */
  zone: NetworkZone
  /** Canvas-space position of the top-left corner. */
  position: CanvasPosition
  /** Width in canvas units (pixels at zoom=1). Default 320. */
  width: number
  /** Height in canvas units (pixels at zoom=1). Default 220. */
  height: number
}

export interface VisualLayer {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport: {
    x: number
    y: number
    zoom: number
  }
  /**
   * Named field site regions overlaid on the canvas.
   * Rendered behind device nodes so devices can be visually grouped inside a site.
   * Optional for backwards compatibility with scenario files created before this field.
   */
  siteRegions?: SiteRegion[]
}

// ── Network layer ─────────────────────────────────────────────────────────────

export interface NetworkSegment {
  zone: NetworkZone
  subnet: string // e.g. "172.20.10.0/24"
  gateway: string // e.g. "172.20.10.1"
  dockerNetwork: string // e.g. "otforge-ot-net"
}

export interface StaticRoute {
  destination: string
  gateway: string
  via: NetworkZone // which segment the route is on
}

export interface NetworkLayer {
  segments: NetworkSegment[]
  routes: StaticRoute[]
}

// ── Device layer ──────────────────────────────────────────────────────────────

export interface ModbusConfig {
  mode: 'tcp' | 'rtu' | 'ascii'
  port: number
  unitId: number
  registers: {
    coils?: Record<string, number> // address → initial value (0/1)
    discreteInputs?: Record<string, number>
    holdingRegisters?: Record<string, number>
    inputRegisters?: Record<string, number>
  }
}

export interface DNP3Config {
  masterAddress: number
  outstationAddress: number
  port: number
}

/**
 * Configuration for a Siemens S7 legacy PLC emulated by containers/conpot.
 * The emulator presents a real S7comm handshake (RFC 1006 / COTP / S7 PDU)
 * that Nmap s7-enumerate and Metasploit siemens_simatic_manager can fingerprint.
 */
export interface S7Config {
  /** Siemens CPU model series — determines order number and firmware in SZL responses. */
  deviceType: '300' | '400' | '1200' | '1500'
  /** S7 TSAP rack number (0 for S7-300, configurable for S7-400 multi-rack). */
  rack: number
  /** S7 TSAP slot number (2 for S7-300/400 CPU, 1 for S7-1200/1500). */
  slot: number
  /** ISO-TSAP port (RFC 1006) — always 102 in standard configurations. */
  port: number
}

/**
 * Configuration for an IEC 60870-5-104 RTU emulated by containers/conpot.
 * The emulator responds to STARTDT, TESTFR, and General Interrogation commands
 * and sends periodic floating-point process values (type M_ME_NC_1).
 */
export interface Iec104Config {
  /** ASDU Common Address — identifies this RTU on a multi-RTU segment (1–65535). */
  commonAddress: number
  /** TCP listening port (IEC 104 standard default is 2404). */
  port: number
}

export interface BacnetConfig {
  /**
   * BACnet device instance number — uniquely identifies this device on the
   * BACnet internetwork (0–4194302). Each device in the scenario must have
   * a distinct instance number for Who-Is / I-Am discovery to work correctly.
   */
  deviceInstance: number
  /** UDP port for BACnet/IP (standard default is 47808). */
  port?: number
  /**
   * Building-automation equipment type — selects which BACnet object set
   * containers/bacnet/server.py serves (see BACNET_KIND in that file).
   * Optional and defaults to 'generic' so scenarios saved before this field
   * existed (e.g. ICS_Lab_02) keep behaving exactly as before.
   *
   *   generic     — Temperature/Pressure/FlowRate/TankLevel + Pump/Valve (original model)
   *   ahu         — Air Handling Unit: supply/return air temp, writable setpoint, fan status+command
   *   vav         — Variable Air Volume box: zone temp, writable setpoint, writable damper position
   *   chiller     — chilled water supply/return temp, writable setpoint, status+command
   *   zone-sensor — read-only room sensor: temperature, humidity, CO2, occupancy
   */
  kind?: 'generic' | 'ahu' | 'vav' | 'chiller' | 'zone-sensor'
}

export interface OpcUaConfig {
  port: number
  namespace: string
  nodes: Array<{ nodeId: string; name: string; dataType: string; value: unknown }>
}

/**
 * EtherNet/IP (CIP over TCP/UDP) configuration for PLCs and RTUs.
 *
 * EtherNet/IP is the primary Ethernet-based industrial protocol used by
 * Rockwell Automation (Allen-Bradley) controllers and most modern OT devices.
 * It carries the Common Industrial Protocol (CIP) and supports both:
 *   - Explicit messaging (TCP 44818) — configuration, programming, on-demand reads
 *   - Implicit messaging / I/O (UDP 2222) — real-time cyclic I/O data exchange
 *
 * OpenPLC Runtime v3's Linux driver compiles in a CIP server on port 44818 by
 * default. The same process variables exposed over Modbus are accessible via CIP
 * object classes (Assembly, Identity, MessageRouter).
 *
 * Tools that use this configuration:
 *   - FUXA HMI (EtherNet/IP driver) — connects to port/slot for live tag reads
 *   - pycomm3 / cpppo — Python libraries used in red-team exercises on Kali
 *   - Nmap NSE scripts (enip-info, cip-info) — fingerprinting during recon
 */
export interface EtherNetIPConfig {
  /**
   * TCP port for CIP explicit messaging.
   * Standard EtherNet/IP port — should always be 44818 unless a non-standard
   * deployment is being simulated.
   */
  port: number
  /**
   * Backplane slot number for the controller in its chassis.
   * 0 for single-controller chassis (most lab PLCs).
   * Needed by FUXA and pycomm3 when forming CIP connection paths.
   */
  slot: number
}

/**
 * PROFINET DCP (Discovery and Configuration Protocol) configuration for a
 * PROFINET IO device.
 *
 * PROFINET is the dominant Ethernet-based fieldbus in automotive and discrete
 * manufacturing (Siemens-centric, competing with EtherNet/IP in that space).
 * Its full stack has three layers:
 *   - DCP — device discovery plus station-name/IP assignment, raw Ethernet
 *     frames (EtherType 0x8892), no authentication in the base spec.
 *   - Context Manager (DCE/RPC over UDP 34964) — establishes the Application
 *     Relationship (AR) between an IO Controller (PLC) and an IO Device
 *     before cyclic data can flow.
 *   - RT (Real-Time) cyclic data — raw Ethernet frames, sub-millisecond
 *     cycle times, the actual process I/O exchange.
 *
 * This device implements DCP only: Identify (discovery), Get, and Set —
 * including the unauthenticated station-name and IP "Set" requests that let
 * anyone on the segment rename or re-address a real device with no
 * credentials, a well-known PROFINET security property worth demonstrating
 * on its own. AR establishment and RT cyclic data are a much larger
 * undertaking (the same scope cut this project already made for EtherNet/IP
 * Class 1 I/O and IEC 61850 GOOSE/SV) and are deferred.
 */
export interface ProfinetConfig {
  /** NameOfStation — PROFINET's primary device identifier, set via DCP instead of a hostname. */
  stationName: string
  /** Vendor ID (16-bit) reported in the DCP Device ID block — GSDML-matched to a device type on a real network. */
  vendorId: number
  /** Device ID (16-bit) reported alongside vendorId — together identify the specific device model. */
  deviceId: number
}

export interface PLCProgramConfig {
  language: 'ladder' | 'st'
  source: string // base64-encoded .st source file
  variables: Array<{
    name: string
    type: string
    address: string // IEC 61131-3 address e.g. %IX0.0
    protocol: Protocol
    protocolAddress: string
  }>
}

/**
 * Configuration for a physics-simulated process unit (Phase 11).
 * The process-sim container runs a real-time physics model and exposes
 * sensor values and control points as Modbus TCP registers.
 *
 * Process types and their primary Modbus outputs:
 *   water-tank  — HR 0 level (m), HR 1/2 inlet/outlet flow (L/min),
 *                 HR 3 hydrostatic pressure (bar), HR 4 temperature (°C)
 *   pipeline    — HR 3 line pressure (bar), HR 1/2 pump/outlet flow,
 *                 HR 0 fill % mapped to 0–10 m scale
 *   generator   — HR 6 frequency (Hz), HR 7 terminal voltage (%),
 *                 HR 8/9 active/reactive power (MW/MVAR)
 *   generic     — HR 0–3 configurable sine/sawtooth signals
 */
export interface ProcessUnitConfig {
  /** Physics model to run inside the container. */
  processType: 'water-tank' | 'pipeline' | 'generator' | 'generic' | 'batch-reactor'
  /** Simulation timestep in milliseconds (default 1000). Lower = faster transients. */
  simDtMs?: number

  // ── Reproducibility controls ────────────────────────────────────────────
  // These two exist for automated evaluation, where a recorded control sequence
  // must replay to the same trajectory. Both are omitted from ordinary teaching
  // scenarios, which want run-to-run variety and wall-clock pacing.
  /**
   * Seed for the instrument-noise RNG. Pinning it makes an identical control
   * sequence reproduce the same process trajectory on any host.
   *
   * When omitted the container draws a seed itself and logs it at startup, so a
   * classroom run stays varied but can still be replayed after the fact by
   * setting this field to the seed that run logged.
   */
  simSeed?: number
  /**
   * Real-time pacing (default true). When false the simulator advances ticks as
   * fast as the event loop allows while simulated time still moves by exactly
   * simDtMs per tick — the trajectory is identical, it just arrives sooner,
   * which makes batches of evaluation episodes affordable.
   *
   * Not suitable for a scenario a student watches: a fast-forwarded process
   * cannot be observed by polling, since a client samples only a sparse scatter
   * of ticks.
   */
  simRealtime?: boolean

  // ── Water tank parameters ──────────────────────────────────────────────────
  /** Total tank capacity in liters (default 1000). */
  tankVolumeL?: number
  /** Tank cross-sectional area in m² — determines level from volume (default 1.0). */
  tankAreaM2?: number
  /** Maximum outlet pump flow rate in L/min at 100 % VFD speed (default 150). */
  pumpFlowMaxLpm?: number
  /** Maximum inlet flow rate in L/min at 100 % valve opening (default 200). */
  valveFlowMaxLpm?: number
  /** Starting fill level as 0–100 % of TANK_VOLUME_L (default 50). */
  initialLevelPct?: number

  // ── Generator parameters ───────────────────────────────────────────────────
  /** Rated active power output in MW (default 100). */
  generatorRatedMw?: number
  /** Generator inertia constant H in seconds (default 6). Higher = slower frequency swings. */
  generatorInertiaH?: number
  /** Nominal (synchronous) frequency in Hz: 50 for European, 60 for North American (default 50). */
  generatorFreqBase?: number

  // ── Pipeline parameters ────────────────────────────────────────────────────
  /** Internal pipeline volume in liters — affects pressure response speed (default 500). */
  pipelineVolumeL?: number
  /** Maximum pump flow rate into the pipeline in L/min (default 300). */
  pipelinePumpMaxLpm?: number

  // ── Batch reactor parameters ───────────────────────────────────────────────
  // Vessel volume/geometry reuse tankVolumeL/tankAreaM2 above (a batch reactor
  // is physically a vessel, same as water-tank); charge/discharge flow reuse
  // valveFlowMaxLpm/pumpFlowMaxLpm respectively. Only the heat/cool dynamics
  // need new fields — there is no water-tank equivalent for a driven heater
  // or cooling jacket.
  /** Heater-on temperature rise rate in °C/s at the vessel (default 0.05). */
  heaterRateCPerSec?: number
  /** Cooling-jacket-on temperature fall rate in °C/s, added on top of ambient Newton cooling (default 0.08). */
  coolingRateCPerSec?: number
}

/**
 * Runtime configuration for an otforge-dns container (Phase 12).
 *
 * The container runs dnsmasq serving an authoritative zone for a fictitious
 * industrial company. Students start here with OSINT and then pivot to the
 * OT network using IPs/credentials they discover in the web server HTML source.
 *
 * All fields are optional — the container Dockerfile sets safe defaults:
 *   DNS_DOMAIN      = meridian-process.com
 *   WEB_SERVER_IP   = 203.0.113.10   (RFC 5737 documentation prefix)
 *   DNS_UPSTREAM    = 8.8.8.8
 *   MAIL_SERVER_IP  = (same as WEB_SERVER_IP when omitted)
 */
export interface DnsConfig {
  /** Authoritative domain served by this dnsmasq instance (default: meridian-process.com). */
  domain?: string
  /** A-record IP injected for www.<domain> — should match the internet-server IP (default: 203.0.113.10). */
  webServerIp?: string
  /**
   * A-record IP injected for mail.<domain> and MX record target.
   * Should match the email-server device IP in the scenario.
   * When omitted the DNS entrypoint defaults to the same value as WEB_SERVER_IP.
   */
  mailServerIp?: string
  /** Upstream recursive resolver for non-authoritative queries (default: 8.8.8.8). */
  upstream?: string
}

/**
 * Runtime configuration for an otforge-mail container.
 *
 * The container runs an open-relay SMTP server (aiosmtpd on port 25) that
 * accepts all inbound mail without authentication -- modelling the insecure
 * legacy mail infrastructure common in ICS environments.
 *
 * Students exploit this to send phishing emails from Kali using:
 *   curl --url smtp://<mail-ip>:25/ \
 *        --mail-from attacker@evil.com \
 *        --mail-rcpt it@meridian-process.com \
 *        --upload-file phishing.txt
 *
 * All received messages are logged to stdout and saved to /var/mail/ inside
 * the container for forensic verification.
 *
 * All fields are optional — the container Dockerfile sets safe defaults:
 *   MAIL_DOMAIN = meridian-process.com
 */
export interface MailConfig {
  /**
   * Domain displayed in the startup banner and accepted by the SMTP server.
   * (default: meridian-process.com)
   */
  domain?: string
}

/**
 * Runtime configuration for an otforge-dc container.
 *
 * The container runs a real Samba4 Active Directory Domain Controller,
 * provisioned at first start via `samba-tool domain provision` and serving
 * real LDAP (389), Kerberos (88), and SMB (445) — a realistic small
 * OU/user/group structure is seeded automatically, with no deliberately
 * weak/vulnerable accounts (that content belongs to a future attack
 * tutorial, not this device's baseline).
 *
 * Deliberately distinct from the public internet-facing meridian-process.com
 * DNS zone (DnsConfig above) — real organizations commonly split their
 * public site domain from their internal AD namespace the same way.
 *
 * All fields are optional — the container Dockerfile sets safe defaults:
 *   AD_DOMAIN         = MERIDIAN.LOCAL
 *   AD_NETBIOS        = MERIDIAN
 *   AD_ADMIN_PASSWORD = a fixed default (visible in container docs/logs,
 *                       matching this project's convention of every device
 *                       shipping a knowable default credential)
 */
export interface DomainControllerConfig {
  /** Fully-qualified AD domain/realm name (default: MERIDIAN.LOCAL). */
  domainName?: string
  /** Short NetBIOS domain name (default: MERIDIAN). */
  netbiosName?: string
  /** Administrator account password set during provisioning (default: a fixed known value). */
  adminPassword?: string
}

/**
 * Safety Instrumented System configuration for safety-plc devices (IEC 61511).
 *
 * These fields are informational — they are injected as environment variables
 * into the OpenPLC container so students can see the SIS parameters in the
 * properties panel and in container logs, reinforcing SIS design concepts.
 * The underlying runtime is OpenPLC; no SIL certification is implied.
 */
export interface SafetyPlcConfig {
  /**
   * Plain-language description of the safety function this SIS performs.
   * Displayed in the properties panel and injected as SIS_FUNCTION env var.
   * Example: "High Pressure Shutdown — reactor feed isolation"
   */
  sisFunction?: string
  /**
   * Voting architecture for redundant sensor inputs (IEC 61511 terminology).
   * Injected as SIS_VOTING env var.
   *   1oo1 = single sensor, trip on fault
   *   2oo3 = two-out-of-three (most common for SIL 2 applications)
   */
  votingConfig?: '1oo1' | '1oo2' | '2oo2' | '2oo3' | '1oo3'
  /**
   * Proof-test interval in hours — how often the SIS is functionally tested.
   * Injected as SIS_PROOF_TEST_INTERVAL_HR env var for display purposes.
   * Typical values: 8760 (annual), 4380 (semi-annual), 2190 (quarterly).
   */
  proofTestIntervalHr?: number
  /**
   * Human-readable description of the safe state this SIS drives to on trip.
   * Injected as SIS_SAFE_STATE env var.
   * Example: "Close SDV-101, de-energize ESD relay K1"
   */
  safeState?: string
}

/**
 * ISA-88 batch control configuration for batch-controller devices.
 *
 * v1 deliberately models a FIXED 5-phase unit procedure — Charge → Heat →
 * React → Cool → Discharge — rather than an author-editable phase list, so
 * configuring a recipe is just filling in these numeric fields (same shape
 * as SafetyPlcConfig), no new phase-editing UI required. The generated ST
 * (buildBatchProgram in plc-program-gen.ts) implements the real ISA-88
 * state model — IDLE/RUNNING/HELD/ABORTED/COMPLETE — against whichever
 * process-unit (processType 'batch-reactor') the batch-controller is wired
 * to, the same way SafetyPlcConfig's votingConfig drives buildSafetyVotingProgram.
 */
export interface BatchConfig {
  /** Plain-language recipe name, e.g. "Product A — Standard Batch". Displayed in the properties panel. */
  recipeName?: string
  /** CHARGE phase target fill level, as % of the reactor's tankVolumeL (default 80). */
  chargeTargetPct?: number
  /** HEAT phase target temperature in °C (default 70). */
  heatSetpointC?: number
  /** REACT phase hold duration once heatSetpointC is reached, in seconds (default 60). */
  reactHoldSec?: number
  /** COOL phase target temperature in °C before discharge is permitted (default 30). */
  coolSetpointC?: number
  /** DISCHARGE phase target fill level, as % of tankVolumeL, to consider the batch drained (default 5). */
  dischargeTargetPct?: number
}

/**
 * IEEE C37.118 PMU (Phasor Measurement Unit) configuration.
 *
 * These fields are informational — they are injected as environment
 * variables into the otforge-pmu container so students can see the PMU's
 * station identity in the properties panel and container logs. The PMU
 * polls a wired generator process-unit's real freq/voltage/power/reactive
 * registers over Modbus TCP and re-exposes them as a real C37.118 CONFIG-2/
 * DATA/HEADER frame stream — see containers/pmu/server.py.
 */
export interface PmuConfig {
  /** C37.118 IDCODE — the PMU/station identifier a PDC uses to distinguish streams (default 1). */
  idCode?: number
  /** C37.118 STN field — 16-char station name shown in the CONFIG-2 frame (default "OTForge PMU"). */
  stationName?: string
  /** Data frame reporting rate in frames/second — real PMUs commonly use 10/25/30/50/60 (default 30). */
  dataRateFps?: number
  /** Nominal system frequency — 60 Hz (Americas) or 50 Hz (most of the rest of the world) (default 60). */
  nominalFreqHz?: 50 | 60
}

/**
 * Telemetry-focused communication link used by field RTUs to reach the SCADA master.
 * RTUs are deployed in remote or harsh environments (pipelines, power grid, water)
 * where cellular, radio, and satellite are the primary uplink choices.
 *   cellular    — 4G/5G or legacy 2G/3G GPRS; internet-exposed unless on private APN/VPN
 *   radio       — licensed or 900 MHz ISM band; unauthenticated by default
 *   satellite   — VSAT; high latency, often bypasses corporate monitoring stack
 *   mqtt        — MQTT broker over IP/cellular (IIoT edge-to-cloud telemetry pattern)
 *   dnp3-serial — DNP3 over RS-485/232 serial to a radio or telephone modem (classic SCADA)
 */
export type RtuCommType = 'cellular' | 'radio' | 'satellite' | 'mqtt' | 'dnp3-serial'

/**
 * Primary industrial protocol carried between the RTU and the SCADA master.
 * DNP3 and IEC 60870-5-104 are the most common for electric utility and pipeline RTUs.
 * Modbus RTU / TCP is ubiquitous in legacy installations.
 */
export type RtuProtocol = 'dnp3' | 'modbus-rtu' | 'modbus-tcp' | 'iec-104'

/**
 * Whether the RTU sends data only when values change (Report by Exception),
 * is polled on a fixed interval by the master, or both.
 *
 * Security implication: Report-by-Exception makes anomaly detection harder because
 * the master only learns of a value change when the RTU decides to report it.
 * Subtle process drift can go unreported for extended periods.
 */
export type RtuOperatingMode = 'report-by-exception' | 'polled' | 'hybrid'

/**
 * Primary power supply for the RTU field unit.
 * Physical attack surface varies by supply type:
 *   ac            — mains-powered; disrupting shore power kills telemetry
 *   solar-battery — common on remote pipeline stations; battery drain = denial of service
 *   battery       — battery-only deployments have finite operational life
 *   dc            — 24 VDC instrument bus; loss of instrument power affects all loop devices
 */
export type RtuPowerSource = 'ac' | 'solar-battery' | 'battery' | 'dc'

/**
 * Deployment configuration for an RTU (Remote Terminal Unit).
 *
 * RTUs differ from PLCs in their intended environment (remote, harsh conditions),
 * communication medium (cellular, radio, satellite for SCADA backhaul), and
 * programming model (pre-configured drop-down menus, not ladder logic or ST programs).
 * These settings are injected as container environment variables so students can
 * inspect them during red-team and blue-team exercises.
 */
export interface RtuConfig {
  /** Physical or wireless link used to reach the SCADA master. */
  commType: RtuCommType
  /** Primary industrial protocol carried over the communication link. */
  primaryProtocol: RtuProtocol
  /** Whether the RTU reports by exception, is polled on a schedule, or both. */
  operatingMode: RtuOperatingMode
  /** Poll interval in seconds — relevant when operatingMode is polled or hybrid. Default: 60. */
  pollIntervalSec: number
  /** Power supply type — affects physical availability attack surface. */
  powerSource: RtuPowerSource
  /** Free-text description of the physical installation site (e.g. "Pipeline pump station 3"). */
  siteType?: string
}

/**
 * Waveform simulation parameters for the smart-sensor canvas node.
 *
 * smart-sensor DOES spawn a real Docker container — the same otforge-modbus
 * pymodbus image rtu/smart-controller use (containers/modbus/server.py). FUXA
 * cannot act as a Modbus server (verified against FUXA's real source — every
 * device driver it has is a client), so "FUXA generates the value" was never
 * buildable; the container generates this waveform itself and serves it as a
 * real Modbus TCP holding register. compose-generator.ts injects this config
 * as SENSOR_* env vars; configureFuxa() in main/index.ts (not a separate
 * fuxa-provisioning.ts file) wires FUXA up as a Modbus client polling it,
 * exactly like it already does for rtu/scada-server/sensor.
 *
 * `kind` selects which physical instrument this node represents — chosen from a
 * dropdown in the Properties Panel rather than a separate DeviceCategory per
 * sensor type. This keeps adding a new sensor type a config-only change (no new
 * DeviceCategory, no touching every Record<DeviceCategory, ...> exhaustiveness
 * table across the renderer/orchestrator). flow/pressure/level/analyzer/pmu were
 * consolidated from their own former STUB DeviceCategory values into this pattern.
 *
 * The PLC polls sensor values over real Modbus TCP — the container exposes the
 * sensor tag as a holding register at the address in `modbusRegister`.
 * Students can capture this traffic in Wireshark on the OT network.
 *
 * Waveforms (see containers/modbus/server.py's _sensor_value_at()):
 *   sine     — smooth oscillation between min and max (default for most sensors)
 *   random   — white noise bounded by min/max (gas detectors, turbulence)
 *   sawtooth — linear ramp then reset (e.g. tank level during fill/drain cycle)
 *   square   — two-state output (e.g. discrete level switch, pump run/stop)
 *   constant — fixed value at (min + max) / 2 (baseline / fault scenario)
 */
export interface SensorConfig {
  /** Which physical instrument this node represents. Drives the icon, default units/range, and FUXA tag. */
  kind: 'temperature' | 'gas' | 'vibration' | 'flow' | 'pressure' | 'level' | 'analyzer' | 'pmu'
  /**
   * FUXA Simulator waveform type for this sensor tag.
   * Determines the shape of the synthetic process value over time.
   */
  waveform: 'sine' | 'random' | 'sawtooth' | 'square' | 'constant'
  /** Minimum engineering value (bottom of the 4-20 mA / signal range). */
  minValue: number
  /** Maximum engineering value (top of the 4-20 mA / signal range). */
  maxValue: number
  /** Engineering units string displayed on the FUXA HMI gauge (e.g. "°C", "bar", "L/min", "ppm", "mm/s²"). */
  units: string
  /**
   * Random noise added on top of the waveform as a percentage of the full range.
   * 0 = clean waveform; 5 = ±5% noise (typical for field instruments); 20 = noisy.
   */
  noisePercent: number
  /**
   * Modbus holding register address FUXA exposes this tag on (0-based).
   * The PLC reads this register via FC03 to get the current sensor value.
   * Assign unique addresses per sensor — duplicates cause silent value collisions.
   */
  modbusRegister: number
  /**
   * FUXA tag update interval in milliseconds (default 1000).
   * Lower values produce faster waveforms and higher Modbus polling load.
   */
  sampleRateMs?: number
  /**
   * Low end of the normal operating band (optional — used for FUXA alarm config).
   * When the simulated value drops below this threshold, FUXA highlights the tag.
   */
  normalMin?: number
  /**
   * High end of the normal operating band (optional — used for FUXA alarm config).
   * When the simulated value exceeds this threshold, FUXA highlights the tag.
   */
  normalMax?: number
  /**
   * FUXA tag name override. When absent, buildSensorModbusTag() in main/index.ts
   * auto-generates a name from the node ID (e.g. "TT-101" becomes tag "TT_101").
   * Must be unique within the scenario — FUXA uses this as the tag identifier.
   */
  tagName?: string
}

/**
 * Configuration for the smart-controller canvas node.
 *
 * Unlike smart-sensor, smart-controller DOES spawn a real Docker container
 * (defaults to the same otforge-modbus image rtu uses) — these devices are meant
 * to be genuinely attackable, not just synthetic FUXA values. The fields below are
 * injected as CONTROLLER_* env vars (same spirit as SafetyPlcConfig's SIS_* vars)
 * so students can see them in container logs and the Properties Panel — but `kind`
 * and the headline numeric fields (ratedFlowLpm, maxFrequencyHz,
 * chokePositionPercent, downholePressureSetpointBar) are NOT purely informational:
 * containers/modbus/server.py's simulate_controller_reactive() reads them to drive
 * real CO0 (command)/DI0 (status)/HR0/HR1 register behavior — writing CO0 actually
 * starts/stops the device. The remaining descriptive fields (actuatorType,
 * failPosition, travelType, signalType, liftMethod) stay informational-only.
 *
 * `kind` selects which physical device this node represents — chosen from a
 * dropdown in the Properties Panel rather than a separate DeviceCategory.
 * pump/valve/vfd/actuator were consolidated from their own former STUB
 * DeviceCategory values into this pattern; wellhead-controller is the first
 * net-new archetype added directly as a kind (oil&gas wellhead/Christmas-tree
 * controller — choke valve + downhole pressure + artificial-lift control loop).
 */
export interface ControllerConfig {
  /** Which physical device this node represents. Drives the icon and which fields below apply. */
  kind: 'pump' | 'valve' | 'vfd' | 'actuator' | 'wellhead-controller'
  // ── pump ──────────────────────────────────────────────────────────────────
  /** Rated discharge flow at 100% speed, in L/min. */
  ratedFlowLpm?: number
  /** Motor nameplate power, in kW. */
  motorPowerKw?: number
  // ── valve ─────────────────────────────────────────────────────────────────
  /** Actuation method. */
  actuatorType?: 'pneumatic' | 'electric' | 'hydraulic'
  /** Position the valve drives to on loss of signal/power. */
  failPosition?: 'open' | 'closed' | 'last'
  // ── vfd ───────────────────────────────────────────────────────────────────
  /** Maximum output frequency, in Hz (typically 50/60 base, up to ~120 for overspeed). */
  maxFrequencyHz?: number
  // ── actuator ──────────────────────────────────────────────────────────────
  /** Mechanical motion type. */
  travelType?: 'linear' | 'rotary'
  /** Control signal type from the controlling PLC/RTU. */
  signalType?: '4-20mA' | 'discrete' | 'modbus'
  // ── wellhead-controller ───────────────────────────────────────────────────
  /** Current choke valve opening, 0-100%. */
  chokePositionPercent?: number
  /** Downhole pressure setpoint, in bar. */
  downholePressureSetpointBar?: number
  /** Artificial-lift method used to bring fluid to surface. */
  liftMethod?: 'natural' | 'rod-pump' | 'esp' | 'gas-lift'
}

export interface DeviceConfig {
  nodeId: string // matches CanvasNode.id
  category: DeviceCategory
  /** Author-assigned display name shown on the canvas node. Falls back to the category label when absent. */
  label?: string
  ipAddress: string
  protocols: Protocol[]
  modbus?: ModbusConfig
  dnp3?: DNP3Config
  opcua?: OpcUaConfig
  bacnet?: BacnetConfig // BACnet/IP config (sensor devices)
  ethernetip?: EtherNetIPConfig // EtherNet/IP CIP config (plc, rtu devices)
  profinet?: ProfinetConfig // PROFINET DCP config (profinet-device devices)
  s7?: S7Config // Siemens S7comm config (legacy-plc devices, Phase 10)
  iec104?: Iec104Config // IEC 60870-5-104 config (iec104-rtu devices, Phase 10)
  processUnit?: ProcessUnitConfig // Physics process simulation config (Phase 11)
  dns?: DnsConfig // DNS server config (dns-server devices, Phase 12)
  mail?: MailConfig // Mail server config (email-server devices)
  domainController?: DomainControllerConfig // Samba4 AD config (domain-controller devices)
  plcProgram?: PLCProgramConfig
  safetyPlc?: SafetyPlcConfig // SIS config for safety-plc devices
  batch?: BatchConfig // ISA-88 recipe config for batch-controller devices
  pmu?: PmuConfig // IEEE C37.118 station identity for pmu devices
  rtuConfig?: RtuConfig // RTU deployment configuration (rtu, iec104-rtu devices)
  sensor?: SensorConfig // Waveform simulation parameters for smart-sensor canvas nodes (real container)
  controller?: ControllerConfig // Educational parameters for smart-controller canvas nodes (real container)
  dockerImage?: string // override default image for this device type
  /**
   * Additional Purdue Model zone networks to attach this device to, beyond the
   * zone determined by its ipAddress. Used to model intentional misconfigurations
   * (e.g., an attack machine given direct OT access to simulate missing segmentation)
   * or multi-homed devices (e.g., a jump host spanning enterprise and control zones).
   *
   * Each zone name maps to that zone's Docker bridge network; the compose generator
   * auto-assigns a free IP in the .200-.239 host range of that subnet.
   */
  extraNetworks?: NetworkZone[]
}

export interface DeviceLayer {
  devices: Record<string, DeviceConfig> // keyed by nodeId
}

// ── Security layer ─────────────────────────────────────────────────────────────

export type ACLAction = 'allow' | 'deny'

export interface ACLRule {
  id: string
  sourceZone: NetworkZone | 'any'
  destinationZone: NetworkZone | 'any'
  protocol: 'tcp' | 'udp' | 'icmp' | 'any'
  destinationPort: number | 'any'
  action: ACLAction
  comment?: string
}

export interface IDSConfig {
  enabledRulesets: string[] // e.g. ["emerging-scada", "emerging-modbus"]
  disabledRuleIds: number[] // individual Suricata SID overrides
  zeekScripts: string[] // e.g. ["modbus.zeek", "dnp3.zeek"]
  /**
   * Raw Suricata rule text authored in the IDSPanel.
   * Injected as IDS_CUSTOM_RULES_B64 (base64) by compose-generator and decoded
   * to /etc/suricata/rules/custom.rules inside the container at startup.
   * Undefined / empty string means no custom rules file is written.
   */
  customRules?: string
}

export interface SecurityLayer {
  defaultFirewallPolicy: ACLAction // default-deny or default-allow
  firewallRules: ACLRule[]
  ids: IDSConfig
  logging: {
    retentionDays: number
    influxdbEnabled: boolean
    lokiEnabled: boolean
  }
  /**
   * When true, the attack machine can be placed directly on any Purdue layer
   * tab (dragged from the device palette like any other device) to model an
   * insider threat — an attacker who already has a foothold inside the
   * network, rather than the default external-attacker kill-chain model where
   * the attack machine has no visual canvas node and only reaches the
   * internet-dmz zone.
   *
   * compose-generator.ts detects an attack-machine device whose canvas zone
   * (from scenario.visual.nodes) differs from the default 'attacker' zone and
   * automatically adds that zone to the device's extraNetworks, so the
   * placement grants real Docker network access, not just a visual position.
   *
   * Defaults to false/undefined so existing scenarios keep the external-only
   * behavior unless an author explicitly opts in.
   */
  insiderThreat?: boolean
}

// ── Device type registry ───────────────────────────────────────────────────────

export interface DeviceTypeDefinition {
  id: string // unique key e.g. "plc-siemens-s7"
  category: DeviceCategory
  label: string // display name e.g. "Siemens S7-300 PLC"
  iconPath: string // relative path to SVG icon
  defaultProtocols: Protocol[]
  defaultDockerImage: string // GHCR image reference
  defaultPorts: number[]
  configSchema: string // JSON Schema for DeviceConfig validation
  sector?: Sector // null = available in all sectors
}

// ── Scenario pack attack layer ─────────────────────────────────────────────────

export interface DockerLayer {
  image: string // GHCR image e.g. "ghcr.io/ics-sim/attack-oilgas:1.0"
  extendsImage: string // base image this FROM-extends
  description: string
}

// ── Resource estimation ────────────────────────────────────────────────────────

export interface ResourceEstimate {
  estimatedRamMb: number
  estimatedCpuCores: number
  containerCount: number
}

// ── Tutorial system ────────────────────────────────────────────────────────────

/**
 * A single step in a guided tutorial scenario (Phase 13 — Tutorial 01).
 *
 * Tutorial steps are embedded in the scenario's `meta.tutorialSteps` array and
 * displayed in the TutorialPanel floating overlay in both Author and Student modes.
 *
 * The `command` field, if present, is rendered in a copy-to-clipboard code block
 * so students can paste it directly into the attack terminal without typos.
 *
 * The `successCheck` field is a plain-English hint about what the student should
 * observe to confirm the step succeeded (not machine-evaluated — educational UX).
 */
export interface TutorialStep {
  /** Unique identifier for this step — used as React key and progress anchor. */
  id: string
  /** Short title shown in the step header (e.g. "Step 1 — Discover the Target"). */
  title: string
  /** Full instructional body in Markdown (rendered in the panel). */
  body: string
  /** Optional shell command shown in a copy-to-clipboard code block. */
  command?: string
  /** Optional plain-English hint describing what success looks like. */
  successCheck?: string
}

// ── Root .otflab document ──────────────────────────────────────────────────────

export interface OTForgeMeta {
  formatVersion: '1.0'
  name: string
  description: string
  sector: Sector
  author: string
  createdAt: string // ISO 8601
  updatedAt: string
  appVersion: string // minimum OTForge version required
  locked: boolean
  /**
   * When true, the mode badge in the toolbar is a clickable toggle that lets
   * the student switch between Student Mode and Author Mode. Only set on
   * scenarios specifically designed to teach the OTForge interface (e.g. the
   * Navigation Tutorial). All attack labs and regular Student Copy scenarios
   * leave this unset (defaults to false) so the Student Mode badge is always
   * static — students cannot accidentally enter edit mode mid-lab.
   */
  allowModeToggle?: boolean
  brief: string // Markdown — mission objectives shown in Student mode
  requirements: ResourceEstimate
  /**
   * Guided tutorial steps embedded in the scenario.
   * When present, the TutorialPanel floating overlay is shown automatically
   * on scenario load, walking the student through the attack chain step by step.
   */
  tutorialSteps?: TutorialStep[]
}

export interface OTForgeScenario {
  meta: OTForgeMeta
  visual: VisualLayer // omitted in locked export
  network: NetworkLayer
  devices: DeviceLayer
  security: SecurityLayer // omitted in locked export
  registry: DeviceTypeDefinition[] // pack-supplied device type extensions
  packLayers: DockerLayer[] // attack tool layers from scenario pack
}
