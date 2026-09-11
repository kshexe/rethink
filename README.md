# rethink

The goal of this project is to de-cloud LG ThinQ-branded appliances, meaning to communicate with them without using the official LG app and cloud service.
The project is developed by reverse engineering various components of the ThinQ ecosystem.

## Status

A working version of `rethink-cloud` is now available. This is a service which emulates the cloud part of ThinQ and translates the protocol to
HomeAssistant-compatible MQTT.

An optional "bridge" mode is also supported, in which the messages are forwarded to the actual LG ThinQ cloud. This can be used as a reverse-engineering
aid, or simply to allow the user to still use the original LG app alongside HomeAssistant.

This fork tracks **one household's own ThinQ2 fleet**, not a general multi-model catalog - the
device list below is `cloud/devices/` as it actually stands in this fork, kept up to date as each
model is reverse-engineered. For the broader community device list (many more AC/fridge/washer/
dryer/dehumidifier/hood/styler models) this fork branched from, see upstream
[anszom/rethink](https://github.com/anszom/rethink).

- Air Conditioners:
    - 👍 CST_570004_WW, LG ceiling-cassette IDU (multi-split) - full command coverage, no known gaps. Remaining unmodelled telemetry tags are read-only (filter hours, coil temps).
- Fridges:
    - 🫤 2REF21EBNSX_3 - temperature/door/express-mode/smart-care mapped. Energy usage frame decoded structurally but not yet calibrated to Wh. A handful of periodic status frames are still unidentified (read-only telemetry, no command-coverage impact).
    - 🫤 3REK2G03VI200S_2 (김치냉장고/kimchi fridge) - per-compartment storage mode (3 compartments), door sensors, one-touch deodorize all mapped. Energy byte not found yet for this model.
- Washing Machines:
    - 👍 FX\_\_\_S, LG front-load washer sold in Korea - full command coverage including per-cycle energy reporting; the most complete handler in this fork, used as the reference implementation for the two below.
- Dryers:
    - 🫤 RD20\_S - power + remaining-time mapped. Speaks the same key-value protocol as FX\_\_\_S (not an AABB fixed-offset-record protocol some other dryers use); course/option state decode still pending.
- Stylers:
    - 🫤 ST_R_ETH01Y_ - power, course-select (a subset of the full course list) and course-start confirmed against a real unit. State-reading (running status, remaining time, errors) not yet decoded.
- Mini washers:
    - 🫤 MI2D7B (미니워시) - power only. This model has no "send to appliance" button in the LG app at all, so its course/option state can't be captured remotely without physically arming remote-start on the unit first.
- Dishwashers:
    - 🫤 H01 - power and course-select mapped; state-reading not yet decoded.

Appliances not listed above can still be used with bridge mode, but they will not be translated to
MQTT. Contributions - including PRs bringing other models' handlers back in from upstream - are
welcome!

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
- **Ports**: the add-on's ThinQ2 ports default to `4433`/`8886` (both host- and container-side -
  rethink itself listens directly on these, no internal 443/8883 hop). This has no effect on
  device compatibility: appliances always connect to LG's real cloud on 443/8883 and never see
  rethink's own listening port - their traffic is DNAT'd here, and the router rewrites the
  destination port transparently before the packet arrives (see below). Remap the _host_ side from
  the add-on's **Info → Network** tab if any of these host ports are already taken by something
  else (e.g. another bridge add-on).
- **Persistent state** (CA key/cert, bridge per-device store, generated `config.json`) lives under
  the add-on's own `/data`, regenerated from the add-on options on every start - editing the add-on
  options and restarting is enough, no manual `config.json` editing needed.
- The **management web panel** is the primary way to check device/bridge status; there's no need
  to tail container logs for routine use. It's served through HA's ingress (the **OPEN WEB UI**
  button on the add-on's Info page), not a directly-forwarded port, so it works the same way
  regardless of your router/port-forwarding setup - the same as Music Assistant's or Advanced SSH
  & Web Terminal's web UI button.

### Adopting a ThinQ2 appliance by port redirection

For a **ThinQ2** appliance already registered on your LG account, port-redirecting its existing
traffic (instead of resetting/re-pairing it) works and leaves the official app and Google Home
connected. This is the only appliance-adoption method this fork supports - it only bridges the
household's own ThinQ2 appliances, so SoftAP re-provisioning (`rethink-setup`) and ThinQ1 support
were dropped:

1. On your router, DNAT the appliance's outbound `443`/`8883` (matched by its own LAN IP, not a
   blanket rule) to this add-on's host on whatever host ports it's actually published on (default
   `4433`/`8886` - check the add-on's **Info → Network** tab, since this is remappable).
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

(Method and the `advertise_requested_host` fix come from
[anszom/rethink#107](https://github.com/anszom/rethink/pull/107) and the write-up at
[cafe.naver.com/koreassistant/23824](https://cafe.naver.com/koreassistant/23824).)

## Management

A simple web interface is available on a user-defined port (default: 44401). The interface supports:

- listing the devices connected to rethink
- monitoring their communications (with packet injection)
- configuring the bridge mode

### Logging into your LG account

Bridge mode (see below) needs your appliance to already be registered on a real LG account, and
needs rethink to hold a valid LG login session to mirror traffic through. That login happens from
the management panel, not the add-on's options screen - here's why, and the exact steps.

**Why not just put username/password in the add-on options?** Because it isn't a simple
username+password REST call. `signInUrl()` builds a link to LG's actual official sign-in page
(`common.lgthinq.com/signin` - the very page the real LG app opens in its own webview), meant for a
human to look at and type into, not for a server to submit credentials to on your behalf (it may
also involve 2FA/CAPTCHA). There's no way around this short of a real browser doing the login.

**Why does _the rest of the panel_ also have to be a web page, then?** rethink is a standalone
Node.js server, not a Python-based Home Assistant integration - so it doesn't get an HA config
flow. An add-on's options screen can only show a fixed set of predefined key/value fields; it can't
represent things like a dynamic device list, per-device bridge-mode toggles, or live monitoring.
Those need a real UI regardless, and the login modal is just part of that same panel.

Steps:

1. In the management panel, click **"Log into your LG account"**. A modal opens - enter your
   country's 2-letter code (`KR` for Korea) and click **"Log in"**.
2. LG's real official sign-in page opens in a new tab (not rethink's - LG's own server). Log in
   there with your actual LG ThinQ account credentials.
3. On success, LG redirects to its own fixed blank page
   (`kr.m.lgaccount.com/login/iabClose?code=...`) with the login result (an auth code) in the query
   string.
4. rethink has no way to receive that redirect directly (LG's `redirect_uri` is hardcoded to that
   one fixed LG page - LG's OAuth doesn't support third-party apps registering their own callback
   URL, and every HA instance's address is different anyway). So instead: copy that final URL in
   full, paste it into the panel's **"URL"** field, and click **"Continue"**. The server pulls
   `code` out of it, exchanges it with LG for a token, and finishes the login.

This manual copy-the-final-URL step isn't unique to rethink - it's the standard workaround for LG
ThinQ's OAuth across the ecosystem (e.g. the HACS `ha-smartthinq-sensors` integration does the same
thing) because of that hardcoded `redirect_uri`.

### Bridge mode device types

When enabling bridge mode for a device from the panel, "device type" is a 3-digit code, not a free
text field:

| Code | Device                   |
| ---- | ------------------------ |
| 101  | Refrigerator (냉장고)    |
| 201  | Washer (세탁기)          |
| 202  | Dryer (건조기)           |
| 204  | Dishwasher (식기세척기)  |
| 223  | WashTower (워시타워)     |
| 301  | Gas Range (가스레인지)   |
| 302  | Microwave (전자레인지)   |
| 401  | Air Conditioner (에어컨) |

The field autocompletes with these (shown as e.g. `401 (Air Conditioner)`); typing just the number
works too.

## Code

The following code is currently available:

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
