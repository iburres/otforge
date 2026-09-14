# OTForge

[![Build](https://github.com/iburres/otforge/actions/workflows/build.yml/badge.svg)](https://github.com/iburres/otforge/actions/workflows/build.yml)
[![Docker Images](https://github.com/iburres/otforge/actions/workflows/docker.yml/badge.svg)](https://github.com/iburres/otforge/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A free, open-source ICS/SCADA cybersecurity platform for researchers, educators, and students. Build realistic industrial control system environments on your laptop — no hardware, no subscription, no cost.

OTForge serves two purposes. It is a **hands-on training platform** for ICS/SCADA security education, and it is a **reproducible experimental environment** for AI safety research in critical infrastructure — a setting where an autonomous agent's actions have measurable physical consequences and where the same episode can be replayed exactly.

Developed by **Ian Burres**, Professor of Practice at the University of Texas at San Antonio (UTSA), in support of ICS/SCADA security education and research.

---

> ### 🆕 Milestone: Deterministic, Replayable Episodes
> A scenario can now be pinned to a seed and replayed tick for tick. `simSeed` fixes the process simulator's noise stream, tick pacing schedules against a fixed origin instead of accumulating sleep drift, and `simRealtime: false` fast-forwards a run. Two seeded runs of the same lab produce byte-identical process trajectories — including closed-loop runs where a PLC is driving the physics. This is what lets OTForge serve as a scored, reproducible experimental environment rather than only a live training range. See [Research Use](#research-use--ai-safety-in-critical-infrastructure) below.

---

## Screenshots

![OTForge SCADA canvas — OT layer with water treatment devices](docs/screenshots/canvas-ot-layer.png)
*Drag-and-drop SCADA canvas — OT layer with PLC, sensors, actuators, and live Modbus protocol edges*

![Kali Linux attack desktop via noVNC](docs/screenshots/kali-desktop.png)
*Full Kali Linux Xfce4 desktop in a dedicated window — ICS attack toolkit, Wireshark, and Metasploit pre-installed*

![Monitor panel — Suricata IDS alerts and Zeek protocol logs](docs/screenshots/monitor-panel.png)
*Live Suricata IDS alerts and Zeek deep-packet logs during an active Modbus coil-write attack*

![Tutorial panel — guided step-by-step lab overlay](docs/screenshots/tutorial-panel.png)
*Guided tutorial overlay — step-by-step instructions with success checks, copy-to-clipboard commands, and attack context*

![Engineering workstation VNC desktop](docs/screenshots/workstation-desktop.png)
*Engineering workstation Xfce4 desktop — Wireshark, ICS protocol scripts, and one-click shortcuts to OpenPLC and FUXA HMI*

---

## What It Does

OTForge lets you design, deploy, and attack realistic ICS/SCADA environments using a visual drag-and-drop canvas. Each device in your scenario runs as a real Docker container on an isolated virtual network — protocol traffic is genuine, not simulated at the application layer.

**Author a scenario** → drag PLCs, RTUs, IEDs, sensors, and network devices onto the canvas, wire them with protocol edges, write IEC 61131-3 ladder logic, configure the firewall — then click **Run**. Docker Compose spins up the full environment in seconds.

**Attack the scenario** → launch the Kali Linux desktop (Wireshark, Metasploit, ICS-specific tools) in a dedicated OS window via KasmVNC and work through the mission.

**Monitor and analyze** → live Grafana dashboards show Suricata IPS alerts and Zeek protocol logs alongside the InfluxDB process historian.

**Replay the scenario** → pin a seed in the scenario file and the physics replay exactly, run after run, so a result can be reproduced or compared across runs on any host.

---

## Features

### Visual Scenario Builder
- Drag-and-drop SCADA canvas with ISA-5.1 / IEC 81346 standard P&ID symbols
- **Six-zone Purdue Reference Model** network topology (IEC 62443-3-2 / NIST SP 800-82):
  - **OT (L0–L2)** — PLCs, RTUs, IEDs, sensors, actuators, field devices
  - **Control Center (L3)** — HMI, historian, engineering workstation, application/database servers
  - **Plant DMZ (L3.5)** — Firewall, IDS/IPS, router, switch
  - **Enterprise (L4)** — Real Samba4 Active Directory domain controller (LDAP/Kerberos/SMB), web/business servers, enterprise desktops
  - **Internet DMZ (L5)** — Email servers, internet-facing servers
  - **Red Team** — Kali Linux attack machine (isolated attacker network)
- Zone-aware firewall rule editor with nftables enforcement
- Self-healing IP assignment — the compose generator automatically resolves duplicate IPs on every simulation start
- Delete Scenario button — clears all devices with a confirmation prompt
- Export scenarios as `.otflab` files — share with students or the community
- Network Settings modal — configure Docker subnet addresses per zone

### PLC IDE
- Structured Text (ST) editor with syntax highlighting
- SVG ladder logic viewer
- Live deploy to running OpenPLC Runtime containers via the web API
- IEC 61131-3 compliant (Ladder, ST, FBD, SFC, IL)

### Attack Machine — Kali Linux Desktop
- Full Kali Linux Xfce4 desktop via **KasmVNC** — opens in a dedicated OS window
- Moveable to a second monitor for a realistic red team / blue team split-screen setup
- Complete ICS-focused attack toolkit (see below)
- One-click launch from the toolbar when the simulation is running

### Security Monitoring
- Suricata IPS with Emerging Threats ICS ruleset (Modbus, DNP3, EIP anomaly detection)
- Zeek deep-packet analysis with ICS protocol scripts
- Grafana dashboards for real-time alert visualization
- InfluxDB 1.8 process historian

---

## Research Use — AI Safety in Critical Infrastructure

Frontier models are increasingly capable of operating tools autonomously, and critical infrastructure is one of the settings where that capability carries the most consequence. Studying it seriously requires an environment where a model can actually act, where the effect of an action is physical rather than textual, and where the same episode can be run again and come out the same.

Most cyber-physical testbeds that meet that bar are hardware-based, access-controlled, or both. OTForge is neither: it is public, it runs on a laptop, and it is reproducible by anyone who clones the repository.

### What the environment provides

- **Real protocol surfaces, not descriptions of them** — an agent acts by speaking Modbus, DNP3, OPC UA, S7comm, BACnet, or IEC 61850 to a live service, the same as any other client.
- **Physical process state as ground truth** — a water tank, pipeline, generator, or batch reactor integrates real dynamics. Whether an action mattered is read off tank level, flow, pressure, or frequency rather than inferred from a transcript, which makes an unambiguous, machine-checkable grader.
- **Closed-loop control** — a PLC running IEC 61131-3 logic polls the simulated process over a Modbus master link and drives it back, so the environment pushes back on an agent's actions the way a real plant does.
- **Deterministic replay** — `simSeed` pins the noise stream and tick pacing is drift-free, so an identical scenario produces an identical trajectory. Verified byte-identical both standalone and closed-loop with a PLC in the loop.
- **Full defensive telemetry** — Suricata, Zeek, and a process historian record every episode, so the offensive and defensive views of the same run are both available.
- **Layered difficulty** — scenarios range from a single Modbus coil write to multi-stage chains involving OSINT, network pivoting, and safety-system manipulation.

### Directions this supports

- **Capability evaluation** — scoring how far an agent gets on tiered cyber-physical tasks, graded on process state rather than on self-report.
- **Mechanistic interpretability** — a deterministic environment is a precondition for relating a model's internal computation to what it actually did. When an episode replays exactly, behavioral differences can be attributed to the model rather than to environment noise, and a specific physical outcome can be traced back to the decision that produced it.
- **Defensive uplift** — measuring whether model assistance improves detection and response, using the same episodes and the same telemetry.

### Status

The environment and deterministic replay are implemented and verified. A **headless episode API with lock-step tick advancement** — so an external agent and the process clock advance together instead of the agent sampling a free-running simulation — is the next increment and is **not yet built**.

Determinism is configured per process unit in the `.otflab` file (`simSeed`, `simRealtime`, `simDtMs`); these fields are not yet exposed in the properties panel, so scenario-file authoring is the path.

---

## Protocol Support

Real protocol packets flow on Docker virtual networks — scanner tools and exploit frameworks see genuine service fingerprints.

| Protocol | Implementation | Port |
|---|---|---|
| Modbus TCP / RTU / ASCII | pymodbus (Python) | TCP 502 |
| DNP3 | OpenDNP3 (C++) | TCP 20000 |
| OPC UA | node-opcua (Node.js) | TCP 4840 |
| BACnet/IP | bacpypes (Python) | UDP 47808 |
| Ethernet/IP CIP | cpppo (Python) | TCP 44818 |
| IEC 61850 | libiec61850 (C) | TCP 102 |
| S7comm (Siemens S7) | Pure Python (RFC 1006 / COTP / S7 PDU) | TCP 102 |
| IEC 60870-5-104 | Pure Python (APCI / ASDU) | TCP 2404 |
| Modbus TCP (process sim) | pymodbus 3.7 + physics loop (water tank / pipeline / generator) | TCP 502 |
| HTTP (company site) | nginx 1.27 — Meridian Process Controls OSINT target | TCP 80 |
| DNS | dnsmasq — authoritative resolver for meridian-process.com | UDP/TCP 53 |
| LDAP / LDAPS / Kerberos / SMB | Samba 4 Active Directory Domain Controller | TCP 389 / 636 / 88 / 445 |

---

## Attack Toolkit (Kali Linux Container)

| Category | Tools |
|---|---|
| Reconnaissance | nmap, masscan, netdiscover, arp-scan |
| Packet analysis | Wireshark (GUI), tshark, tcpdump, Scapy |
| Exploitation | Metasploit Framework, Armitage (GUI) |
| Credentials | Hydra, Medusa, Patator, John the Ripper, Hashcat |
| ICS/OT specific | pymodbus, dnp3-python, opcua, bacpypes3, python-snap7 (S7comm), impacket, ike-scan |
| Desktop | Full Kali Xfce4 via noVNC (port 6080) — launches in a dedicated OS window |

---

## Requirements

| Requirement | Minimum |
|---|---|
| OS | Windows 10 22H2+ or Windows 11 23H2+, macOS 13+, Ubuntu 22.04+ |
| RAM | 8 GB (16 GB recommended for attack machine scenarios) |
| Disk | 20 GB free (Docker images downloaded on first run) |
| Docker Desktop | Latest stable |
| Node.js | 22+ (development only — Node 20 is EOL and incompatible with Vite 8) |

---

## Quick Start

### First-time setup

```bash
git clone https://github.com/iburres/otforge.git
cd otforge
npm run dev
```

`npm run dev` handles the rest on first run — it installs dependencies, downloads the Electron runtime, builds the packages, and launches the app. (On Windows, first allow scripts once with `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`.)

Docker Desktop must be running before launching the app.

> **Node.js 22+ required.** Vite 8 uses `crypto.hash()`, which was added in Node 21.7. Node 20 will throw `TypeError: crypto.hash is not a function`.

**First-time students:** see the step-by-step setup guide for a full walkthrough covering Docker, Git, Node.js, and OTForge setup on both Windows and macOS.

> **[View Student Setup Guide (browser)](https://iburres.github.io/otforge/student-setup.html)** &nbsp;|&nbsp; [Markdown source](docs/student-setup.md)

### Getting updates

**Preferred — the in-app button.** With a lab loaded, click **Update OTForge** in the toolbar. It pulls the latest code, updates dependencies, and refreshes the Docker container images for the loaded scenario in one step. A plain `git pull` updates source only and does **not** refresh container images, so services or attack scripts added in a new lab can appear missing until the images are refreshed — the button handles both. Image refresh only runs when a scenario is loaded, so open a lab before clicking.

If the update changes OTForge's own code it will ask you to restart: stop the app and run `npm run dev` again — any queued dependency update is applied automatically during that startup, while Electron is not running.

**Code-only fallback:**

**Windows (PowerShell in `C:\OTForge`):**
```powershell
git pull
npm run dev
```

**macOS / Linux:**
```bash
bash get-updates.sh
```

> **Windows:** do not run `npm ci` on updates — it wipes `node_modules` and breaks Electron. Only run it once during initial setup.
> **macOS:** `git pull` alone causes a `package-lock.json` conflict (npm rewrites it with platform-specific entries). The script handles the reset automatically.

### Build a distributable

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

---

## Project Structure

```
otforge/
├── packages/
│   ├── app/                  # Electron application
│   │   └── src/
│   │       ├── main/         # Node.js main process (IPC, Docker, OpenPLC API)
│   │       ├── preload/      # contextBridge API surface
│   │       └── renderer/     # React + TypeScript UI
│   │           └── src/
│   │               ├── canvas/       # React Flow SCADA canvas + layer tabs
│   │               ├── palette/      # Device palette (ISA-5.1 symbols)
│   │               ├── properties/   # Device inspector + PLC IDE panel
│   │               ├── terminal/     # Attack terminal modal (KasmVNC)
│   │               ├── monitor/      # Grafana + Loki monitor panel
│   │               ├── settings/     # Network subnet settings modal
│   │               ├── tutorial/     # TutorialPanel guided step-by-step overlay
│   │               └── icons/        # SVG device icons
│   ├── orchestrator/         # Docker Compose generator + DockerClient
│   └── schema/               # Shared TypeScript types (OTForgeScenario, DeviceConfig…)
├── containers/               # Docker image source (one per device category)
│   ├── openplc/              # OpenPLC Runtime
│   ├── suricata/             # Suricata IPS with ICS rules
│   ├── zeek/                 # Zeek network monitor
│   └── firewall/             # nftables firewall
├── scenarios/                # Bundled .otflab scenario files
│   ├── Learning_to_navigate_OTForge.otflab    # Guided tour of every major feature
│   ├── OpenPLC_Lab.otflab                     # Ladder Diagram basics (IEC 61131-3)
│   ├── ICS_Lab_01.otflab                      # Modbus coil write attack
│   ├── ICS_Lab_02.otflab                      # ICS protocol survey
│   ├── ICS_Lab_03.otflab                      # DNP3 IDS/IPS (oil & gas)
│   ├── ICS_Lab_04.otflab                      # TRITON/TRISIS SIS compromise
│   ├── IEC61850_Tutorial.otflab               # Substation MMS control
│   ├── ISA88_Batch_Tutorial.otflab            # ISA-88 recipe tampering
│   └── Building_Automation_Tutorial.otflab    # BACnet HVAC survey
└── .github/
    └── workflows/            # CI: build, Docker image publish, CodeQL, secret scan
```

---

## Network Architecture

Each scenario runs six isolated Docker bridge networks matching the Purdue Reference Model:

| Zone | Network | Subnet | Devices |
|---|---|---|---|
| OT (L0–L2) | `ot-net` | 10.200.10.0/24 | PLC, RTU, IED, sensor, actuator, pump, valve, flow meter, pressure transmitter |
| Control Center (L3) | `control-net` | 10.200.20.0/24 | HMI, historian, engineering workstation, application server, database server |
| Plant DMZ (L3.5) | `plant-dmz-net` | 10.200.30.0/24 | Firewall, IDS/IPS, router, switch |
| Enterprise (L4) | `enterprise-net` | 10.200.40.0/24 | Domain controller, web server, business server, enterprise desktop |
| Internet DMZ (L5) | `internet-dmz-net` | 10.200.50.0/24 | Email server, internet server |
| Red Team | `attacker-net` | 10.200.60.0/24 | Kali Linux attack machine |

System services (InfluxDB, Loki, Grafana, FUXA, Promtail) occupy `.240`–`.249` in their respective zone; user devices start at `.10` and increment automatically.

---

## Scenario Format

Scenarios are saved as `.otflab` JSON files with four layers:

```json
{
  "meta":     { "name": "Water Treatment Plant", "sector": "water", "version": "1.0" },
  "visual":   { "nodes": [...], "edges": [...] },
  "network":  { "segments": [...], "protocolEdges": [...] },
  "devices":  { "devices": { "plc-1": { ... }, "rtu-1": { ... } } },
  "security": { "firewallRules": [...], "idsConfig": { ... } }
}
```

Share your scenarios with the community — open a pull request against the [otforge-scenarios](https://github.com/iburres/otforge-scenarios) repository (coming soon).

### Community Scenario Packs (.otfpack)

Pack multiple scenarios, custom device types, and sector-specific detection rules into a single `.otfpack` ZIP:

```
pack.json                    — manifest (id, name, version, author, sector, ...)
scenarios/                   — pre-built .otflab scenario files
devices/
  registry.json              — custom device types (label + Docker image override)
  icons/                     — SVG icons displayed in the palette
rules/
  suricata/                  — .rules files (Emerging Threats format)
  zeek/                      — .zeek protocol analysis scripts
```

Install packs via **Toolbar → Packs → Install Pack** (Author mode). Installed packs appear in the Pack Manager where you can open bundled scenarios or uninstall packs. Custom device types from packs appear in the palette under **Pack Devices**, draggable onto the canvas like any built-in device.

---

## Bundled Labs

Nine instructor-ready scenarios ship in the `scenarios/` folder and load directly from the OTForge canvas. Each includes a guided overlay with step-by-step instructions and success checks.

**Start here**

| Scenario | File | Description |
|---|---|---|
| **Learning to Navigate OTForge** | `Learning_to_navigate_OTForge.otflab` | Hands-on tour of every major feature. Starting from a single PLC and process unit, students build a complete multi-layer ICS scenario from scratch, exploring the full device palette, the PLC IDE, the firewall and IDS panels, and the monitoring stack. |
| **OpenPLC Lab 01** | `OpenPLC_Lab.otflab` | IEC 61131-3 Ladder Diagram basics. Students write a one-rung LD program mapping a command coil to a pump output, compile it to Structured Text, and upload it to a live OpenPLC runtime. |

**Protocol and attack labs**

| Scenario | File | Description |
|---|---|---|
| **ICS Lab 01** — Modbus Coil Write Attack | `ICS_Lab_01.otflab` | Full ICS attack chain — OSINT recon against a fictitious industrial company website, DNS enumeration, network scanning, and a Modbus TCP coil write that closes an outlet valve and causes a water tank overflow. |
| **ICS Lab 02** — ICS Protocol Survey | `ICS_Lab_02.otflab` | Students connect from the engineering workstation to each field device and read live process values using Modbus TCP, DNP3, OPC UA, and BACnet/IP. Protocol-literacy prerequisite for the attack scenarios. |
| **ICS Lab 03** — IDS/IPS on an Oil & Gas SCADA Network | `ICS_Lab_03.otflab` | Students act as a network security engineer at a fictional gas pipeline operator, using Suricata and Zeek to detect an attacker issuing unauthorized DNP3 Direct Operate commands on the OT network. |
| **ICS Lab 04** — TRITON/TRISIS Safety System Compromise | `ICS_Lab_04.otflab` | Modeled on the real 2017 TRITON/TRISIS incident against a Triconex Safety Instrumented System. A multi-stage chain through a petrochemical reactor unit, ending at the safety layer. |

**Sector tutorials**

| Scenario | File | Description |
|---|---|---|
| **IEC 61850 Tutorial** — Substation MMS Control | `IEC61850_Tutorial.otflab` | Feeder-bay substation automation. An attacker on the substation LAN sends an unauthorized MMS control command, and students work the resulting detection gap. |
| **ISA-88 Batch Tutorial** — Recipe Tampering | `ISA88_Batch_Tutorial.otflab` | ISA-88 batch control and its most distinctive attack surface, a directly writable recipe-phase register. Students run a real five-phase batch to completion, then force-skip a phase. |
| **Building Automation Tutorial** — BACnet HVAC Survey | `Building_Automation_Tutorial.otflab` | BACnet/IP building equipment — an air handling unit, two VAV boxes, a chiller, and a read-only zone sensor — read and operated from the engineering workstation. |

Additional labs and scenario packs will be published in the [otforge-scenarios](https://github.com/iburres/otforge-scenarios) repository (coming soon).

---

## Recent Additions

### Deterministic Process Simulation
The process simulator can be pinned to a seed and replayed exactly, which is what turns a scenario into a repeatable experiment.

- **`simSeed`** seeds a private noise RNG, so sensor noise is reproducible. The seed is always logged — an unseeded run prints the seed it drew, so any run stays replayable after the fact
- **Drift-free tick pacing** — ticks are scheduled against a fixed origin instead of sleeping `dt` each cycle, cutting accumulated drift from 0.3% to 0.03%. Without this, an external action lands on a different tick each run
- **`simRealtime: false`** fast-forwards a run as fast as the event loop allows, for offline analysis rather than live observation
- Emission is opt-in, so scenarios without these fields generate byte-identical Compose output to before

### Closed-Loop PLC ↔ Process Wiring Fix
Edges that connect a PLC to a process unit *through* a visual-only glyph — a pump, valve, or sensor symbol drawn on the canvas — name the controlling PLC inside the edge rather than as an endpoint. The compose generator was discarding those edges before reading that binding, so affected scenarios never received `PROCESS_SIM_IP`, their OpenPLC started with no Modbus master configuration, and the simulated process never responded to its own controller.

Now fixed and covered by tests: the PLC drives the process, the tank responds, and closed-loop runs replay deterministically.

### Real Active Directory Domain Controller
The **domain-controller** device is now a genuine Samba4 Active Directory Domain Controller, not a stub — the first real implementation of enterprise identity infrastructure anywhere in OTForge.

- Provisioned automatically at container start (`samba-tool domain provision`) with a realistic seeded domain — organizational units, employee accounts, and security groups across IT/Engineering/Operations departments
- Serves real **LDAP** (389/636), real **Kerberos** (88), and real **SMB** (445) simultaneously — the same three protocols a real Windows domain runs on
- Genuine security behavior, not a simplified stand-in: unencrypted LDAP binds are correctly rejected, legacy SMB1 is refused, and directory enumeration requires real authentication — exactly like production Active Directory
- Students can run real tools against it from the Kali attack machine: `ldapsearch`, `kinit`, `smbclient`, `rpcclient`, and impacket's example scripts (now joined by `ldap3` and the BloodHound Python collector)
- Closes the IT/Enterprise zone gap — OTForge now models every layer of the Purdue Reference Model with a real running service, from field-level OT protocols through enterprise identity infrastructure

### Apple Silicon (ARM64) Native Support
All container images now build and run natively on Apple Silicon Macs (M1/M2/M3/M4) — no QEMU emulation, no architecture mismatch warnings in Docker Desktop.

- **OpenPLC Runtime** — compiled natively on a `ubuntu-24.04-arm` GitHub Actions runner; eliminates the Rosetta 2 crash caused by the snap7 S7comm library
- **Infrastructure images** (InfluxDB 1.8, FUXA, Grafana, Loki, Promtail) — multi-platform manifests published to GHCR covering both `linux/amd64` and `linux/arm64`
- **Engineering workstation** remains `amd64` only — `dnp3-python` and `python-snap7` have no ARM64 wheels on PyPI

### Platform-Aware Update Workflow
- **Windows:** `git pull && npm run dev` — no `npm ci` on updates (it wipes `node_modules` and breaks Electron)
- **macOS:** `bash get-updates.sh` — resets `package-lock.json` before pulling to avoid the platform-specific lock file conflict, then reinstalls and rebuilds
- **`fix-electron.ps1`** — checks the local `%LOCALAPPDATA%\electron\Cache` before downloading from GitHub; eliminates the ~90 MB re-download on machines that have previously installed Electron

---

## Development Status

| Phase | Feature | Status |
|---|---|---|
| 0 | Electron shell, Docker check, first-launch flow | ✅ Complete |
| 1 | Orchestration engine (Compose generator, LevelDB, resource estimator) | ✅ Complete |
| 2 | SCADA canvas (React Flow, ISA-5.1 icons, zones, drag-drop) | ✅ Complete |
| 3 | Container images (GHCR images, GitHub Actions CI/CD) | ✅ Complete |
| 4 | PLC IDE (ST editor, ladder viewer, variable bindings, live deploy) | ✅ Complete |
| — | Attack terminal → KasmVNC Kali desktop in dedicated OS window | ✅ Complete |
| 5 | DNP3 IED auto-config + security stack UI (FirewallPanel, IDSPanel, nftables/Suricata/Zeek) | ✅ Complete |
| — | Connection validation — Purdue Reference Model matrix (IEC 62443-3-2 / NIST SP 800-82) | ✅ Complete |
| 6 | Monitoring panels — Grafana ICS Lab Overview + native Loki log viewer + Promtail sidecar | ✅ Complete |
| — | Six-zone Purdue Model restructure (OT / Control / Plant DMZ / Enterprise / Internet DMZ / Attacker) | ✅ Complete |
| — | Self-healing IP deduplication in compose generator | ✅ Complete |
| — | Network Settings modal — per-zone subnet configuration | ✅ Complete |
| — | Delete Scenario button with confirmation | ✅ Complete |
| 7 | FUXA HMI embed + PLC → HMI Modbus wiring | ✅ Complete |
| 8 | Author / Student mode split + locked scenario distribution | ✅ Complete |
| 9 | Community scenario pack format (.otfpack ZIP — Pack Manager, custom device types, bundled Suricata/Zeek rules) | ✅ Complete |
| 10 | Conpot legacy device emulation (Siemens S7, IEC 104) | ✅ Complete |
| 11 | Physical process simulation (water tank, pipeline, generator dynamics) | ✅ Complete |
| 12 | Attack infrastructure — company website (Meridian Process Controls), DNS server, Kali noVNC desktop | ✅ Complete |
| 13 | Guided tutorial system — TutorialPanel overlay, Tutorial 01 (Modbus Coil Write), DnsConfig schema | ✅ Complete |
| — | Apple Silicon native ARM64 support — all container images multi-platform, OpenPLC native build | ✅ Complete |
| 14 | macOS + Linux packaging and distribution | 🔜 Planned |
| 15 | Deterministic process simulation (`simSeed`, drift-free tick pacing, `simRealtime` fast-forward) | ✅ Complete |
| 16 | Headless episode API with lock-step tick advancement | 🔜 Planned |

---

## Open Source Components

This project would not be possible without these open-source tools:

| Component | Role | License |
|---|---|---|
| [OpenPLC Runtime](https://github.com/thiagoralves/OpenPLC_v3) | IEC 61131-3 PLC execution engine | GPL-3.0 |
| [FUXA](https://github.com/frangoteam/FUXA) | Web-based SCADA/HMI | MIT |
| [Suricata](https://github.com/OISF/suricata) | Network IPS / IDS | GPL-2.0 |
| [Zeek](https://github.com/zeek/zeek) | Network traffic analysis | BSD-3 |
| [Grafana](https://github.com/grafana/grafana) | Dashboards and visualization | AGPL-3.0 |
| [Loki](https://github.com/grafana/loki) | Log aggregation | AGPL-3.0 |
| [InfluxDB 1.8](https://github.com/influxdata/influxdb) | Time-series process historian | MIT |
| [React Flow](https://github.com/xyflow/xyflow) | SCADA canvas | MIT |
| [xterm.js](https://github.com/xtermjs/xterm.js) | Terminal emulator | MIT |
| [Kali Linux (linuxserver)](https://github.com/linuxserver/docker-kali-linux) | Penetration testing OS via KasmVNC | Various |

Third-party Docker images are pulled from public registries at runtime and are not bundled in this repository.

---

## Contributing

Contributions are welcome — bug reports, new device types, scenario packs, protocol implementations, and documentation improvements are all valuable.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/dnp3-master-station`)
3. Commit your changes with clear messages
4. Open a pull request

For large changes, open an issue first to discuss the approach.

---

## License

Application source code: [MIT](LICENSE)

Runtime Docker images are governed by their own licenses — see the [LICENSE](LICENSE) file for a full list.

---

## Author

**Ian Burres**
Professor of Practice — Cybersecurity, University of Texas at San Antonio (UTSA)
Former: Sandia National Laboratories
ORCID: [0009-0006-1320-9956](https://orcid.org/0009-0006-1320-9956)
