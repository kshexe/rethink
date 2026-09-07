# rethink

The goal of this project is to de-cloud LG ThinQ-branded appliances, meaning to communicate with them without using the official LG app and cloud service.
The project is developed by reverse engineering various components of the ThinQ ecosystem.

## Status

A working version of `rethink-cloud` is now available. This is a service which emulates the cloud part of ThinQ and translates the protocol to
HomeAssistant-compatible MQTT.

An optional "bridge" mode is also supported, in which the messages are forwarded to the actual LG ThinQ cloud. This can be used as a reverse-engineering
aid, or simply to allow the user to still use the original LG app alongside HomeAssistant.

The following appliances are currently supported in rethink:

- Air Conditioners:
    - 👍 LG DualCool family (Standard 2, Deluxe with and without air purifier, etc.) wall-mounted Air Conditioner IDUs - high level of support. What's missing are mostly some features of higher-end models and more diagnostic coverage,
    - 👍 LW1822HRSM, Smart Window Air Conditioner - mostly working,
    - 👍 LP1022FVSM Portable Air Conditioner - mostly working,
    - 👍 CST_570004_WW, LG ceiling-cassette IDU (multi-split) - mostly working,
- Fridges:
    - 🫤 LF28H8330S, Standard-Depth 4-Door French Door Refrigerator - preliminary support,
    - 🫤 GSJV70PZTE, LG Side by Side Refrigerator - preliminary support,
    - 🫤 GSB470BASZ, American Style Side by Side Refrigerator - preliminary support,
    - 🫤 GA-B509CMUM - preliminary support,
- Washing Machines:
    - 👍 FX\_\_\_S, LG front-load washer sold in Korea - mostly working,
    - 🫤 (model name unknown) Washing Machine - preliminary support
    - 👍 F2J7HG1W, Washing Machine - mostly working,
    - 🫤 F4WV508S2E, Front-Loading Washing Machine - preliminary support
    - 🫤 F4WV709P1E, Front-Loading Washing Machine - preliminary support
    - 🫤 TW4V9RW9W - preliminary support
    - 👍 F4X7511TWS (VCDWL2QEUK), Front-Load Washing Machine - mostly working
    - 🫤 WT7300CW - preliminary support
    - 👍 WM3900HBA (F3L2CYU\_\_), Front-Load Washing Machine - mostly working
    - 👍 FV1413H2B, Washing Machine - mostly working,
    - 👍 F3L7CYK5W_US_WIFI, Front-Load Washing Machine - mostly working
    - 👍 F2V5PS0W, Front-Load Washing Machine - mostly working
- Dryers:
    - 🫤 DLE7300WE - preliminary support
    - 👍 DLEX3900B (RV13B6BSD_D_US_WIFI), Electric Dryer - mostly working
    - 👍 RV13B6ES_D_US_WIFI, Electric Dryer - mostly working
- WashTowers (combined washer+dryer):
    - 👍 WKEX200HBA (WTL_FXU_BDV_NA_01), WashTower - mostly working
- Dehumidifiers
    - 👍 MD19GQGE0, Smart Dehumidifier - mostly working
- Range Hoods:
    - 👍 HCED3015D (STUDIO_HOOD), Generic identifier and probably works with multiple models. Working.
- Stylers:
    - 👍 S5BBP (ST_B_E4H01Y_APL), Styler - mostly working

The supported appliances can be used "out of the box" with HomeAssistant or another compatible MQTT consumer.  
Appliances not listed above can still be used with the bridge mode, but they will not be translated to MQTT. Contributions are welcome!

Most of the findings from the reverse engineering process are available on the [project wiki](https://github.com/anszom/rethink/wiki) as well.

## Installation

See the [instructions](https://github.com/anszom/rethink/wiki/Installing-rethink‐cloud).

### As a Home Assistant add-on

This fork also ships as a Home Assistant add-on (`config.yaml`/`Dockerfile`/`rootfs` at the repo
root), so it can be added directly as an add-on repository:
**Settings → Add-ons → Add-on Store → ⋮ → Repositories → `https://github.com/kshexe/rethink`**.

Notes specific to running it this way:

- **`hostname`** (add-on option) must resolve via regular DNS on your LAN, not mDNS - point a
  static DNS entry (e.g. in your router/UniFi) at whatever host the add-on runs on. This is a
  rethink requirement, not an add-on limitation - see the note in `config.jsonc` upstream.
- **Ports**: the add-on exposes 443/8883/46030/47878/44401 with their default container-internal
  binds. Remap the _host_ side from the add-on's **Info → Network** tab if any of those host ports
  are already taken by something else (e.g. another bridge add-on) - rethink itself keeps listening
  on the plain defaults inside its own container, so compatibility with devices that dislike
  non-default ports (see the warning in `config.jsonc`) is unaffected either way.
- **Persistent state** (CA key/cert, bridge per-device store, generated `config.json`) lives under
  the add-on's own `/data`, regenerated from the add-on options on every start - editing the add-on
  options and restarting is enough, no manual `config.json` editing needed.
- The **management web panel** (port 44401) is the primary way to check device/bridge status;
  there's no need to tail container logs for routine use.

### Adopting a ThinQ2 appliance without SoftAP re-provisioning

`rethink-setup`'s SoftAP pairing is not the only way to hand an appliance to rethink. For a
**ThinQ2** appliance already registered on your LG account, port-redirecting its existing traffic
(instead of resetting/re-pairing it) works and leaves the official app and Google Home connected:

1. On your router, DNAT the appliance's outbound `443`/`8883` (matched by its own LAN IP, not a
   blanket rule) to this add-on's host on the same ports.
2. Turn on **`advertise_requested_host`** in the add-on options - `/route` then echoes back
   whatever hostname the appliance already asked for (its real per-unit SNI, e.g.
   `kic-mclip.lgthinq.com`), instead of forcing everything onto this add-on's own `hostname`. This
   also makes it survive multiple units of the same model that each expect a different name -
   rethink issues a matching certificate per requested SNI.
3. Enable **bridge mode** for the device from the management panel to keep the app/Google Home
   working. Registration is left alone if the appliance is already in your account (no
   delete-and-recreate, no `Rethink xxxxxxxx` rename, no Google Home desync).
4. To revert: disable bridge mode **first**, then remove the DNAT rule, then clear the router's
   conntrack entry for that device's IP. Removing the DNAT rule before disabling bridge mode
   leaves the appliance and the bridge fighting over the same AWS IoT client ID (the appliance's
   own device ID) in a reconnect loop that looks like a dead certificate but isn't.

- Don't redirect DNS for this instead of using port DNAT - the appliance caches the resolved IP,
  so undoing it later needs a power cycle to clear.
- This path is ThinQ2-only; ThinQ1 appliances still need real re-provisioning.

(Method and the `advertise_requested_host` fix come from
[anszom/rethink#107](https://github.com/anszom/rethink/pull/107) and the write-up at
[cafe.naver.com/koreassistant/23824](https://cafe.naver.com/koreassistant/23824).)

## Management

A simple web interface is available on a user-defined port (default: 44401). The interface supports:

- listing the devices connected to rethink
- monitoring their communications (with packet injection)
- configuring the bridge mode

## Code

The following code is currently available:

- [rethink-setup](rethink-setup.ts) - a simple tool to perform the "initial setup" from a Wi-Fi connected PC, without using the official LG app
- [rethink-cloud](rethink-cloud.ts) - a server that replaces LG's cloud service. It's meant to be installed on your local network and hosts its own simplistic MQTT broker.

Miscelanneous utilities:

- [packet-parser](tools/packet-parser.ts) - an utility to interpret TLV-formatted packets received from the appliance via MQTT. It connects to rethink-cloud
- [packet-sender](tools/packet-sender.ts) - an utility to create TLV-formatted packets & send them via MQTT to the appliance. It connects to rethink-cloud
- [appliance simulator](tools/appliance-simulator) - a program which allows the Wi-Fi module to be operated without connection to an appliance. It simulates a minimum set of UART responses to activate the Wi-Fi module.
- [lgcloud-monitor](tools/lgcloud-monitor.ts) - connects to the official LG cloud just like the official app would and displays real-time notifications about your devices straight from the MQTT feed. Useful for understanding how the LG cloud processes device updates.
- [rethink-capture](tools/rethink-capture.ts) - records a device's live wire traffic (and optionally the time-aligned LG cloud notifications) to a JSONL capture file, with inline annotations, for offline reverse-engineering in an LLM-friendly format.
- [mcp-server](tools/mcp-server.ts) - an [MCP](https://modelcontextprotocol.io) server that exposes the reverse-engineering toolkit (decode/encode packets, enumerate devices, capture device & cloud traffic, inject and probe packets) to an LLM agent.

## Notice

LG ThinQ is likely a registered trademark, or whatever, I don't care. The name is used here for identification purposes only. I'm not in any way affiliated with LG.

## Warning

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

This means that if your device breaks, you get to fix it yourself or keep both pieces.
