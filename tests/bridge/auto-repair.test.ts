import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage } from 'node:http'
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '@/bridge/index'
import type { BridgeState, Credentials } from '@/bridge/state'
import { Client, Thinq2Device, type Thinq2DeviceState } from '@/bridge/thinqApi'
import { ExponentialBackoff } from '@/util/backoff'
import { Broker } from '@/cloud/mqtt-broker'
import { DeviceManager } from '@/cloud/devmgr'
import type { Metadata } from '@/cloud/thinq'
import * as frameRecorder from '@/cloud/frame-recorder'
import { MockThinq2Device } from '../helpers/mocks'

// Reproduces, end to end, the 2026-10-06 live finding (스타일러): a bridge connection that gets
// rejected before 'connect' ever fires, every single retry, forever - no amount of retrying with
// the same stored credentials can ever fix that (see bridge/index.ts's own comment on
// consecutivePreConnectFailures). These pin that Bridge now does automatically, instead of needing
// someone to notice and do a manual disable+enable, what that manual toggle has always done:
// re-register for a fresh certificate after enough consecutive pre-connect failures in a row - and
// that it does not do this on every blip, only after the threshold, and not more than once per
// cooldown window even if the device keeps failing the exact same way afterwards.

const COUNTRY = 'KR'
const HOME_ID = 'home-1'
const DEVICE_ID = 'aaaabbbb-cccc-dddd-eeee-ffff00002222'
const META: Metadata = { modelId: 'ST_R_ETH01Y_', modelName: 'ST_R_ETH01Y_', swVersion: '1.0', deviceType: '203' }
const SUB_TOPIC = `clip/message/devices/${DEVICE_ID}`
const PROV_TOPIC = `clip/provisioning/devices/${DEVICE_ID}`

// 4000ms was enough running this file alone (confirmed: 3/3 clean solo runs) but flaked once under
// the full `npm test` suite's CPU contention (56 files' worth) - "timed out waiting for disconnect
// #1", a plain socket-close-to-publishProperty propagation delay, not a logic bug. Generous enough
// margin here costs nothing on the common (fast) path, since `until` returns as soon as `cond()`
// is true regardless of this ceiling.
async function until(cond: () => boolean, what: string, ms = 30000) {
    const end = Date.now() + ms
    while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
        await new Promise((r) => setTimeout(r, 10))
    }
}

type Recorded = { url: string; body: Record<string, unknown> }

// Stands in for every LG REST endpoint register()/enable() touches (gateway, OAuth2 token
// refresh+profile, home listing, otp, addDevice) - everything except Thinq2Device.pair() itself,
// which talks to a hardcoded external host (thinqApi.ts's IOT_BASE_URL) unrelated to the Client's
// configured gateway and is monkey-patched below instead of faked here.
class FakeLgApi {
    server!: HttpServer
    requests: Recorded[] = []

    async listen() {
        this.server = createHttpServer((req, res) => {
            const chunks: Buffer[] = []
            req.on('data', (c: Buffer) => chunks.push(c))
            req.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf-8')
                let body: Record<string, unknown> = {}
                try {
                    body = raw ? JSON.parse(raw) : {}
                } catch {
                    body = { raw }
                }
                this.requests.push({ url: req.url!, body })
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify(this.respond(req)))
            })
        })
        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
        return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    }

    respond(req: IncomingMessage): unknown {
        const url = req.url!
        if (url.endsWith('/oauth/1.0/oauth2/token'))
            return { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }
        if (url.endsWith('/users/profile')) return { status: 1, account: { userNo: 'u1', userID: 'tester' } }
        if (url.endsWith('/service/homes') && !url.includes(HOME_ID))
            return { resultCode: '0000', result: { item: [{ homeId: HOME_ID, currentHomeYn: 'Y' }] } }
        if (url.endsWith(`/service/homes/${HOME_ID}`))
            return { resultCode: '0000', result: { devices: [{ deviceId: DEVICE_ID, alias: '스타일러' }] } }
        if (url.endsWith('/service/devices/otp/certificate'))
            return { resultCode: '0000', result: { otp: '000000', publicKey: 'unused-stub' } }
        if (url.endsWith(`/service/homes/${HOME_ID}/devices`)) return { resultCode: '0000', result: {} }
        return { resultCode: '0000', result: {} }
    }

    async close() {
        await new Promise((resolve) => this.server.close(resolve))
    }
}

class FakeState implements BridgeState {
    deviceStates = new Map<string, Thinq2DeviceState>()
    credentials: Credentials | undefined
    getCredentials() {
        return this.credentials
    }
    setCredentials(c: Credentials | undefined) {
        this.credentials = c
    }
    getDeviceState(id: string) {
        return this.deviceStates.get(id)
    }
    setDeviceState(id: string, state: Thinq2DeviceState | undefined) {
        if (state) this.deviceStates.set(id, state)
        else this.deviceStates.delete(id)
    }
    getDeviceNames(): Record<string, string> {
        return {}
    }
    setDeviceNames() {}
    getAutoAck(): Record<string, boolean> {
        return {}
    }
    setAutoAck() {}
}

describe('Bridge auto-repairs a connection stuck failing before connect', () => {
    let notesDir: string
    let lgApi: FakeLgApi
    let lgBaseUrl: string
    let originalPair: typeof Thinq2Device.prototype.pair

    // The fake "cloud MQTT broker" this test's bridged device actually connects to. Controls how
    // many consecutive connection attempts get rejected (raw socket destroyed, before the mqtt
    // library ever gets a CONNACK) vs accepted for real.
    let cloudServer: TcpServer
    let cloudPort: number
    let sockets: Set<Socket>
    let rejectUntilAttempt: number // attempts [0, rejectUntilAttempt) are destroyed; the rest succeed
    let attemptCount: number
    let broker: Broker
    let originalForLgCloud: typeof ExponentialBackoff.forLgCloud
    // Set by each test right after constructing its Bridge, so afterEach can force-clean it up -
    // see afterEach's own comment for why relying on each test's own close() alone isn't enough.
    let currentBridge: Bridge | undefined

    beforeEach(async () => {
        // BridgedDevice's real backoff (2s doubling to 60s) means accumulating REPAIR_THRESHOLD
        // consecutive failures takes ~30s of real wall-clock time - sped up here to keep this
        // file fast without touching the production threshold/backoff values themselves.
        originalForLgCloud = ExponentialBackoff.forLgCloud
        ExponentialBackoff.forLgCloud = () => new ExponentialBackoff(10, 50)

        notesDir = mkdtempSync(join(tmpdir(), 'rethink-auto-repair-'))
        frameRecorder.configure({ dir: notesDir, days: 1 })

        lgApi = new FakeLgApi()
        lgBaseUrl = await lgApi.listen()
        Client.gatewayCache[COUNTRY] = Promise.resolve({
            thinq2Uri: lgBaseUrl,
            uris: { empOauthBaseUri: lgBaseUrl, empFrontBaseUri2: lgBaseUrl },
        })

        broker = new Broker()
        sockets = new Set()
        attemptCount = 0
        rejectUntilAttempt = 0
        cloudServer = createTcpServer((s) => {
            sockets.add(s)
            s.on('close', () => sockets.delete(s))
            const attempt = attemptCount++
            if (attempt < rejectUntilAttempt) {
                s.destroy() // rejected before the mqtt client ever gets a CONNACK
            } else {
                broker.accept(s)
            }
        })
        await new Promise<void>((resolve) => cloudServer.listen(0, '127.0.0.1', resolve))
        cloudPort = (cloudServer.address() as AddressInfo).port

        // Thinq2Device.pair() normally talks to a hardcoded external host completely unrelated to
        // the Client's (fakeable) gateway - see IOT_BASE_URL in thinqApi.ts. Stubbed here to do
        // what it ultimately does (set .state to point at the live mqtt server) without any real
        // network/crypto, so re-pairing in this test reconnects to our own fake cloud server.
        originalPair = Thinq2Device.prototype.pair
        Thinq2Device.prototype.pair = async function (this: Thinq2Device) {
            this.state = {
                apiServer: lgBaseUrl,
                mqttServer: `mqtt://127.0.0.1:${cloudPort}`,
                countryCode: COUNTRY,
                caCertificate: '',
                privateKey: '',
                certificate: '',
                pubTopic: `clip/message/devices/${this.deviceId}/pub`,
                provTopic: PROV_TOPIC,
                subTopic: SUB_TOPIC,
            }
            return Buffer.from('')
        }
    })

    afterEach(async () => {
        // Defensive, found necessary the hard way (2026-10-06): a #rePair() still in flight when a
        // test ends (racing register()'s async network calls against the test's own close() call)
        // can resurrect a BridgedDevice after the test function has already returned - enable()
        // captures `dev` from manager.allDevices once, before its awaits, so removing the device
        // doesn't retroactively stop an enable() already past that point. The resurrected device's
        // reconnect loop, sped up by this file's own fast test backoff, then spent the rest of a
        // whole `npm test` run hammering the by-then-closed cloudServer with ECONNREFUSED -
        // sometimes also racing frame-recorder's global config against whichever other test file
        // happened to be mid-write at the time, corrupting its notes. disable() is a no-op if
        // nothing is bridged, so this is harmless on the common path where nothing resurrects.
        for (let i = 0; i < 10 && currentBridge && currentBridge.bridgedDevices.size > 0; i++) {
            currentBridge.disable(DEVICE_ID)
            await new Promise((r) => setTimeout(r, 50))
        }
        currentBridge = undefined

        ExponentialBackoff.forLgCloud = originalForLgCloud
        Thinq2Device.prototype.pair = originalPair
        delete Client.gatewayCache[COUNTRY]
        await lgApi.close()
        for (const s of sockets) s.destroy()
        await new Promise((resolve) => cloudServer.close(resolve))
        frameRecorder.configure({ dir: '/share/rethink/frames', days: 0 })
        rmSync(notesDir, { recursive: true, force: true })
    })

    async function notes(): Promise<{ kind: string; [k: string]: unknown }[]> {
        // Wait for every record()/note() call made so far to actually land, rather than guessing
        // at a fixed delay - see frame-recorder's flush() and tlv_device.test.ts's identical fix
        // (2026-10-06) for the race a fixed sleep leaves open.
        await frameRecorder.flush()
        const today = new Date().toISOString().slice(0, 10)
        try {
            return readFileSync(join(notesDir, `${today}.jsonl`), 'utf-8')
                .trim()
                .split('\n')
                .map((l) => JSON.parse(l))
        } catch {
            return []
        }
    }

    test('5 consecutive pre-connect failures trigger exactly one automatic re-pair, which then connects', async () => {
        const manager = new DeviceManager()
        const state = new FakeState()
        state.credentials = { env: { countryCode: COUNTRY }, refreshToken: 'refresh' }
        // Already registered from a previous pairing, same as the real styler - bridging starts
        // on its own via loadSavedDevice, no manual enable() needed.
        state.deviceStates.set(DEVICE_ID, {
            apiServer: lgBaseUrl,
            mqttServer: `mqtt://127.0.0.1:${cloudPort}`,
            countryCode: COUNTRY,
            caCertificate: '',
            privateKey: '',
            certificate: '',
            pubTopic: `clip/message/devices/${DEVICE_ID}/pub`,
            provTopic: PROV_TOPIC,
            subTopic: SUB_TOPIC,
        })

        const bridge = new Bridge(state, manager)
        currentBridge = bridge
        const started: string[] = []
        const stopped: string[] = []
        bridge.on('started', (id) => started.push(id))
        bridge.on('stopped', (id) => stopped.push(id))

        const device = new MockThinq2Device(DEVICE_ID, META)
        device.managed = true

        // First 5 connection attempts (across however many BridgedDevice instances they belong
        // to) are rejected before CONNACK; everything from the 6th on succeeds for real.
        rejectUntilAttempt = 5

        manager.accept(device)
        await until(() => started.length === 1, 'the device to auto-bridge from saved state')

        // Exactly one repair cycle: the original BridgedDevice stops, a new one starts, and it
        // actually reaches 'online' this time (the 6th attempt is let through).
        await until(() => stopped.length === 1 && started.length === 2, 'exactly one disable+enable repair cycle')
        await until(() => bridge.status(DEVICE_ID) === 'online', 'the repaired connection to actually connect')

        const repairNotes = (await notes()).filter((n) => n.kind === 'bridge-auto-repaired' && n.id === DEVICE_ID)
        assert.equal(repairNotes.length, 1)

        // Re-registering really did go through register()/addDevice(), not just update local state.
        assert.ok(lgApi.requests.some((r) => r.url.endsWith(`/service/homes/${HOME_ID}/devices`)))

        device.emit('close')
        await until(() => [...sockets].every((s) => s.closed), 'the final connection to close')
    })

    test('a single connect, then a later close, never triggers a repair (the ordinary reconnect case)', async () => {
        const manager = new DeviceManager()
        const state = new FakeState()
        state.credentials = { env: { countryCode: COUNTRY }, refreshToken: 'refresh' }
        state.deviceStates.set(DEVICE_ID, {
            apiServer: lgBaseUrl,
            mqttServer: `mqtt://127.0.0.1:${cloudPort}`,
            countryCode: COUNTRY,
            caCertificate: '',
            privateKey: '',
            certificate: '',
            pubTopic: `clip/message/devices/${DEVICE_ID}/pub`,
            provTopic: PROV_TOPIC,
            subTopic: SUB_TOPIC,
        })

        const bridge = new Bridge(state, manager)
        currentBridge = bridge
        const started: string[] = []
        const stopped: string[] = []
        bridge.on('started', (id) => started.push(id))
        bridge.on('stopped', (id) => stopped.push(id))

        const device = new MockThinq2Device(DEVICE_ID, META)
        device.managed = true

        rejectUntilAttempt = 0 // every attempt connects for real

        manager.accept(device)
        await until(() => bridge.status(DEVICE_ID) === 'online', 'the first connect')

        // Kill the live connection from the cloud side 4 times in a row (ordinary transport
        // hiccups after a real connect) - well past the 5-failure threshold if these wrongly
        // counted as pre-connect failures.
        for (let i = 0; i < 4; i++) {
            for (const s of sockets) s.destroy()
            await until(() => bridge.status(DEVICE_ID) === 'offline', `disconnect #${i + 1}`)
            await until(() => bridge.status(DEVICE_ID) === 'online', `reconnect #${i + 1}`)
        }

        assert.equal(started.length, 1, 'never repaired - only the original start')
        assert.equal(stopped.length, 0)
        assert.deepEqual(
            (await notes()).filter((n) => n.kind === 'bridge-auto-repaired'),
            [],
        )

        device.emit('close')
        await until(() => [...sockets].every((s) => s.closed), 'the final connection to close')
    })

    test('repeated pre-connect failures right after a repair do not trigger a second repair (cooldown)', async () => {
        const manager = new DeviceManager()
        const state = new FakeState()
        state.credentials = { env: { countryCode: COUNTRY }, refreshToken: 'refresh' }
        state.deviceStates.set(DEVICE_ID, {
            apiServer: lgBaseUrl,
            mqttServer: `mqtt://127.0.0.1:${cloudPort}`,
            countryCode: COUNTRY,
            caCertificate: '',
            privateKey: '',
            certificate: '',
            pubTopic: `clip/message/devices/${DEVICE_ID}/pub`,
            provTopic: PROV_TOPIC,
            subTopic: SUB_TOPIC,
        })

        const bridge = new Bridge(state, manager)
        currentBridge = bridge
        const started: string[] = []
        const stopped: string[] = []
        bridge.on('started', (id) => started.push(id))
        bridge.on('stopped', (id) => stopped.push(id))

        const device = new MockThinq2Device(DEVICE_ID, META)
        device.managed = true

        // Attempts 0-4 fail, attempt 5 (the repaired connection) succeeds, attempts 6-10 fail again.
        rejectUntilAttempt = 5

        manager.accept(device)
        await until(() => stopped.length === 1 && started.length === 2, 'the first repair cycle')
        await until(() => bridge.status(DEVICE_ID) === 'online', 'the repaired connection to connect')

        rejectUntilAttempt = 11 // now also reject the post-repair connection's own retries

        for (const s of sockets) s.destroy() // kill the just-established connection to start the second failure streak
        await until(() => attemptCount >= 11, 'five more pre-connect failures to accumulate')

        // Give the (would-be, if the cooldown didn't block it) async #rePair plenty of time to run.
        await new Promise((r) => setTimeout(r, 300))

        assert.equal(started.length, 2, 'still only the one repair - the cooldown blocked a second one')
        assert.equal(stopped.length, 1)
        assert.equal(
            (await notes()).filter((n) => n.kind === 'bridge-auto-repaired').length,
            1,
            'only the first repair left a note',
        )

        rejectUntilAttempt = 0 // let the final teardown's socket(s) close cleanly rather than racing more rejects
        device.emit('close')
        // Missing here once: without this, the test function returned while the sped-up (10-50ms)
        // backoff timer was still live, outliving this test - afterEach tore down cloudServer/lgApi
        // out from under it, and it then spent the rest of the whole test run hammering the now-dead
        // port as fast as its backoff allowed, racing frame-recorder's global config (shared with
        // whichever other test file happened to be mid-write at the time) and corrupting its notes.
        await until(() => [...sockets].every((s) => s.closed), 'the final connection to close')
    })
})
