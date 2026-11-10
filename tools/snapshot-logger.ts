// Long-running, all-devices companion to rethink-capture.ts --poll-snapshot: one authenticated
// cloud session, cycling through every device on the account and logging the cloud's own
// semantic snapshot (course/state/temperature/... - see Bridge.getDeviceStatus's own comment)
// on a timer, so an eventually-nonzero reading on a mystery raw tag can be matched against a
// named field after the fact, without needing to catch it live.
//
// Deliberately NOT rethink-capture.ts's --cloud mode run N times: that also opens an MQTT push
// connection per process (each pinning its own AWS IoT clientId - see util/lgcloud/monitor.ts's
// own file header on why they can't share one), which for a whole account's worth of devices
// run continuously is a lot of standing connections for a value this tool doesn't need. One
// REST client polling in a loop is what a background logger actually wants.
//
// Usage:
//   tsx tools/snapshot-logger.ts [--state <path>] [--interval-ms <n>] [--out-dir <dir>] [deviceId ...]
//
// With no device ids given, polls every device the account has registered (via listDevices()) -
// which for a bridged setup is exactly the bridged ones. Writes one JSONL file per device,
// <out-dir>/<deviceId>.jsonl, each line {ts, deviceId, snapshot} (or {ts, deviceId, error}).
// ts is an ISO string in UTC, matching the frame recorder's own `/share/rethink/frames/*.jsonl`
// timestamps - the two logs are meant to be read side by side by device id + time.
//
// Only writes a line when the snapshot/error differs from the last one written for that
// device (appendEvent dedupes in-memory, per device) - most devices sit in the same state
// for far longer than the poll interval, and logging every unchanged poll grew these files
// to multi-GB within weeks with nothing to show for it. A line's absence just means "still
// the same as the previous line," so a gap's start time is read off the one line before it.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { authenticate } from '@/util/lgcloud/monitor'
import { loadState, saveState } from '@/util/lgcloud/state'
import { RemoteError } from '@/bridge/thinqApi'

// Device gone from the account (unregistered/disconnected) - re-authenticating can never fix
// this, so retrying it after every single poll just doubles the wasted work and log noise.
// Keep polling on the normal schedule (it recovers on its own once the device reconnects),
// just skip the pointless reauth-and-retry step for this one error code.
const PERMANENT_ERROR_CODE = '0101'

let statePath: string | undefined
let intervalMs = 20_000
let outDir = 'snapshots'
const deviceIdsArg: string[] = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--state') statePath = argv[++i]
    else if (a.startsWith('--state=')) statePath = a.slice('--state='.length)
    else if (a === '--interval-ms') intervalMs = Number(argv[++i])
    else if (a.startsWith('--interval-ms=')) intervalMs = Number(a.slice('--interval-ms='.length))
    else if (a === '--out-dir') outDir = argv[++i]
    else if (a.startsWith('--out-dir=')) outDir = a.slice('--out-dir='.length)
    else deviceIdsArg.push(a)
}

fs.mkdirSync(outDir, { recursive: true })

function log(msg: string) {
    console.error(`[${new Date().toISOString()}] ${msg}`)
}

const lastWritten = new Map<string, string>()

function appendEvent(deviceId: string, event: object) {
    const key = JSON.stringify(event)
    if (lastWritten.get(deviceId) === key) return
    lastWritten.set(deviceId, key)
    const line = JSON.stringify({ ts: new Date().toISOString(), deviceId, ...event }) + '\n'
    fs.appendFileSync(path.join(outDir, `${deviceId}.jsonl`), line)
}

async function main() {
    const state = loadState(statePath)
    if (!state) {
        console.error(
            `No stored credentials at ${statePath ?? 'oauth.json'}. Run tools/rethink-capture.ts --cloud once ` +
                `(or write a compatible {countryCode, refreshToken} state file) to create one - this tool is ` +
                `non-interactive by design and won't prompt for a login.`,
        )
        process.exit(1)
    }

    const client = await authenticate(state)
    // authenticate() only sets up the client itself; homeId (needed by listDevices) is set by
    // Client.auth() as part of the same call, so it is already populated here.
    saveState(state, statePath) // no-op if unchanged, but keeps the file fresh if auth() rotated anything

    let deviceIds = deviceIdsArg
    if (deviceIds.length === 0) {
        const devices = await client.listDevices()
        deviceIds = devices.map((d) => d.deviceId)
        log(`polling all ${deviceIds.length} devices on the account: ${deviceIds.join(', ')}`)
    } else {
        log(`polling ${deviceIds.length} device(s): ${deviceIds.join(', ')}`)
    }

    log(`interval ${intervalMs}ms per device, writing to ${path.resolve(outDir)}/`)

    // Stagger requests within one cycle rather than firing all at once - gentler on the
    // account's rate limit, and avoids every device's write landing in the same JSONL flush.
    const staggerMs = deviceIds.length > 0 ? Math.max(200, Math.floor(intervalMs / deviceIds.length / 2)) : 0

    // The access token client.auth() fetches is short-lived (LG's OAuth server hands out ~1h
    // tokens) and nothing here was refreshing it - a first, unattended overnight run confirmed
    // this the hard way: all 8 devices went to ERROR_FAILED_LOGIN in the same ~10s window once
    // the token expired, and stayed there for the rest of the run since there was no recovery
    // path at all. Two layers now: proactively re-auth on a timer well inside the token's own
    // lifetime, and reactively re-auth once and retry on any error (covers an expiry landing
    // between proactive refreshes, or any other transient auth hiccup).
    const REAUTH_INTERVAL_MS = 40 * 60 * 1000
    let lastAuthAt = Date.now()

    async function reauth(reason: string) {
        log(`re-authenticating (${reason})`)
        await client.auth(state!.refreshToken)
        lastAuthAt = Date.now()
    }

    for (;;) {
        if (Date.now() - lastAuthAt > REAUTH_INTERVAL_MS) {
            try {
                await reauth('scheduled refresh')
            } catch (err) {
                log(`scheduled re-auth failed, will retry next cycle: ${err instanceof Error ? err.message : err}`)
            }
        }

        for (const id of deviceIds) {
            try {
                const snapshot = await client.getDeviceStatus(id)
                appendEvent(id, { snapshot })
            } catch (err) {
                if (err instanceof RemoteError && err.resultCode === PERMANENT_ERROR_CODE) {
                    appendEvent(id, { error: err.message })
                } else {
                    try {
                        await reauth('after error: ' + (err instanceof Error ? err.message : String(err)))
                        const snapshot = await client.getDeviceStatus(id)
                        appendEvent(id, { snapshot })
                    } catch (err2) {
                        appendEvent(id, { error: err2 instanceof Error ? err2.message : String(err2) })
                    }
                }
            }
            await new Promise((resolve) => setTimeout(resolve, staggerMs))
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, intervalMs - staggerMs * deviceIds.length)))
    }
}

main().catch((err) => {
    console.error('fatal:', err)
    process.exit(1)
})
