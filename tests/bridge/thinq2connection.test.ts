import { describe, test, afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '@/bridge/index'
import type { BridgeState, Credentials } from '@/bridge/state'
import { Connection as Thinq2Connection } from '@/bridge/thinq2connection'
import { Thinq2Device as Thinq2ClientDevice, type Thinq2DeviceState } from '@/bridge/thinqApi'
import { Broker } from '@/cloud/mqtt-broker'
import { DeviceManager } from '@/cloud/devmgr'
import type { Metadata } from '@/cloud/thinq'
import * as frameRecorder from '@/cloud/frame-recorder'
import { MockThinq2Device } from '../helpers/mocks'

const DEVICE_ID = 'eff416a1-7832-132c-a6e7-3034db631a60'
const META: Metadata = { modelId: 'BDVG_FX0003_US', modelName: 'BDVG_FX0003_US', swVersion: '0.0.0' }
const SUB_TOPIC = `clip/message/devices/${DEVICE_ID}`
const PROV_TOPIC = `clip/provisioning/devices/${DEVICE_ID}`

// Captured from the ThinQ cloud to an LG dryer while bridged (upstream anszom/rethink#203, 2026-09-24):
// its ack of the dryer's `30 4d 01` course-list request.
const CLOUD_ACK = 'AA08F0004D04A6BB'
const CLOUD_PACKET = 'AA12F0ED1121010000001804111200005EBB'

class FakeState implements BridgeState {
    deviceStates = new Map<string, Thinq2DeviceState>()
    getCredentials(): Credentials | undefined {
        return undefined
    }
    setCredentials() {}
    getDeviceState(id: string) {
        return this.deviceStates.get(id)
    }
    setDeviceState() {}
    getDeviceNames(): Record<string, string> {
        return {}
    }
    setDeviceNames() {}
    getAutoAck(): Record<string, boolean> {
        return {}
    }
    setAutoAck() {}
}

async function until(cond: () => boolean, what: string, ms = 2000) {
    const end = Date.now() + ms
    while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
        await new Promise((r) => setTimeout(r, 10))
    }
}

// The real Bridge -> BridgedDevice -> Thinq2Connection path, with rethink's own broker standing in for
// the ThinQ cloud's and a mock appliance downstream.
describe('Thinq2Connection, bridged', () => {
    let broker: Broker
    let server: Server
    let sockets: Set<Socket>
    let device: MockThinq2Device
    let preDeployed: boolean

    // `managed`: whether a rethink handler has claimed the device, which the bridge reads on connecting
    async function connect(managed = false) {
        broker = new Broker()
        sockets = new Set()
        server = createServer((s) => {
            sockets.add(s)
            broker.accept(s)
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

        const state = new FakeState()
        state.deviceStates.set(DEVICE_ID, {
            countryCode: 'US',
            apiServer: 'http://127.0.0.1:1',
            mqttServer: `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`,
            caCertificate: '',
            privateKey: '',
            certificate: '',
            pubTopic: `clip/message/devices/${DEVICE_ID}/pub`,
            provTopic: PROV_TOPIC,
            subTopic: SUB_TOPIC,
        })

        // preDeploy is published after the subscribe, so once it arrives the connection can receive
        preDeployed = false
        broker.on('publish', (packet) => {
            if (packet.topic === PROV_TOPIC) preDeployed = true
        })

        const manager = new DeviceManager()
        new Bridge(state, manager)
        device = new MockThinq2Device(DEVICE_ID, META)
        device.managed = managed
        manager.accept(device)
        await until(() => preDeployed, 'preDeploy')
    }

    afterEach(async () => {
        device.emit('close') // ends the bridge's MQTT client; let it close its socket before the server goes
        await until(() => [...sockets].every((s) => s.closed), 'the client to disconnect')
        await new Promise((resolve) => server.close(resolve))
    })

    function fromCloud(cmd: string, data: string) {
        const payload = Buffer.from(JSON.stringify({ did: DEVICE_ID, cmd, type: 1, data }))
        broker.publish({ topic: SUB_TOPIC, payload, qos: 0, dup: false, retain: false }, null)
    }

    test("the cloud's ack reaches the appliance as an ack, not a packet", async () => {
        await connect()
        fromCloud('ack', CLOUD_ACK)
        await until(() => device.sent.length > 0, 'the ack')
        assert.deepEqual(device.sent, [{ cmd: 'ack', type: 1, data: CLOUD_ACK }])
        assert.deepEqual(device.outbox, [])
    })

    // A handler acks for itself if it needs to (AABBDevice's autoAck), so the cloud's would be duplicates.
    test("the cloud's ack does not reach an appliance that has a handler", async () => {
        await connect(true)
        fromCloud('ack', CLOUD_ACK)
        fromCloud('packet', CLOUD_PACKET) // same connection, so it arrives after the one above
        await until(() => device.outbox.length > 0, 'the packet')
        assert.deepEqual(device.sent, [])
    })

    test('a packet still reaches the appliance as a packet', async () => {
        await connect()
        fromCloud('packet', CLOUD_PACKET)
        await until(() => device.outbox.length > 0, 'the packet')
        assert.deepEqual(
            device.outbox.map((b) => b.toString('hex').toUpperCase()),
            [CLOUD_PACKET],
        )
        assert.deepEqual(device.sent, [])
    })

    test('any other command is not forwarded', async () => {
        await connect()
        fromCloud('somethingNew', 'AA00')
        fromCloud('packet', CLOUD_PACKET) // same connection, so it arrives after the one above
        await until(() => device.outbox.length > 0, 'the packet')
        assert.equal(device.outbox.length, 1)
        assert.deepEqual(device.sent, [])
    })
})

// Added 2026-10-01: a connection failure used to leave only an ephemeral console line, which was
// already gone by the time anyone went looking for why 안방에어컨's bridge had quietly stopped
// forwarding - see thinq2connection.ts's own comment on `connectedOnce`. These pin the one thing
// that matters for diagnosing the *next* one: whether a note actually lands, and whether it
// correctly tells a failure before the cloud ever accepted this connection (needs a fresh
// register()/pair() - the credentials themselves are suspect) apart from one after it (the
// existing close-triggered reconnect already handles this with the same credentials).
describe('Thinq2Connection records why a bridge connection died', () => {
    let notesDir: string

    beforeEach(() => {
        notesDir = mkdtempSync(join(tmpdir(), 'rethink-bridge-notes-'))
        frameRecorder.configure({ dir: notesDir, days: 1 })
    })

    afterEach(() => {
        frameRecorder.configure({ dir: '/share/rethink/frames', days: 0 }) // back to disabled
        rmSync(notesDir, { recursive: true, force: true })
    })

    // `until()` above checks `cond()` synchronously (`!cond()`), which would treat any Promise as
    // already-truthy and return instantly without ever awaiting it - fine for every other test in
    // this file, wrong for a condition that itself needs to read the notes file.
    async function untilAsync(cond: () => Promise<boolean>, what: string, ms = 2000) {
        const end = Date.now() + ms
        while (!(await cond())) {
            if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
            await new Promise((r) => setTimeout(r, 10))
        }
    }

    async function notes(): Promise<{ kind: string; [k: string]: unknown }[]> {
        // note() appends through frame-recorder's own promise chain - see its file header -
        // rather than writing synchronously.
        await new Promise((r) => setTimeout(r, 50))
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

    test('a close after a real connect is noted as post-connect, not a credentials problem', async () => {
        const broker = new Broker()
        const sockets = new Set<Socket>()
        const server = createServer((s) => {
            sockets.add(s)
            broker.accept(s)
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

        const device = new Thinq2ClientDevice(DEVICE_ID, META, {
            countryCode: 'US',
            apiServer: 'http://127.0.0.1:1',
            mqttServer: `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`,
            caCertificate: '',
            privateKey: '',
            certificate: '',
            pubTopic: `clip/message/devices/${DEVICE_ID}/pub`,
            provTopic: PROV_TOPIC,
            subTopic: SUB_TOPIC,
        })

        let ready = false
        const connection = new Thinq2Connection(device)
        connection.once('ready', () => (ready = true))
        await until(() => ready, 'ready')
        assert.equal(connection.connectedOnce, true)

        for (const s of sockets) s.destroy() // the cloud's side hangs up
        await untilAsync(
            async () => (await notes()).some((n) => n.kind === 'bridge-connection-closed'),
            'the close note',
        )

        const closeNotes = (await notes()).filter((n) => n.kind === 'bridge-connection-closed')
        assert.equal(closeNotes.length, 1)
        assert.equal(closeNotes[0].connectedOnce, true)

        connection.destroy()
        await new Promise((resolve) => server.close(resolve))
    })

    test('a connection the cloud never accepts is noted before connect - the credentials are the suspect', async () => {
        // Nothing is listening on this port, so the TCP connect itself fails - the mqtt client
        // never gets anywhere near a CONNACK.
        const unusedPort = 1
        const device = new Thinq2ClientDevice(DEVICE_ID, META, {
            countryCode: 'US',
            apiServer: 'http://127.0.0.1:1',
            mqttServer: `mqtt://127.0.0.1:${unusedPort}`,
            caCertificate: '',
            privateKey: '',
            certificate: '',
            pubTopic: `clip/message/devices/${DEVICE_ID}/pub`,
            provTopic: PROV_TOPIC,
            subTopic: SUB_TOPIC,
        })

        const connection = new Thinq2Connection(device)
        let sawError = false
        connection.on('error', () => (sawError = true))
        await until(() => sawError, 'the connect error')
        assert.equal(connection.connectedOnce, false)

        const failNotes = (await notes()).filter((n) => n.kind === 'bridge-connection-failed')
        assert.equal(failNotes.length, 1)
        assert.equal(failNotes[0].stage, 'connect')

        connection.destroy()
    })

    // The actual 2026-10-01 bug (anszom/rethink#110): preDeploy failing at the application level
    // used to leave the socket itself untouched - still open, CONNACK already received - so
    // 'close' never fired and bridge/index.ts's close-triggered reconnect never ran. Simulated
    // here by monkey-patching the live mqtt client's subscribe() to reject without the real
    // connection ever actually dropping, which `until()`'s synchronous setup reliably beats the
    // real async TCP handshake to do.
    test('a preDeploy failure forces the connection closed instead of leaving it to rot', async () => {
        const broker = new Broker()
        const sockets = new Set<Socket>()
        const server = createServer((s) => {
            sockets.add(s)
            broker.accept(s)
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

        const device = new Thinq2ClientDevice(DEVICE_ID, META, {
            countryCode: 'US',
            apiServer: 'http://127.0.0.1:1',
            mqttServer: `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`,
            caCertificate: '',
            privateKey: '',
            certificate: '',
            pubTopic: `clip/message/devices/${DEVICE_ID}/pub`,
            provTopic: PROV_TOPIC,
            subTopic: SUB_TOPIC,
        })

        const connection = new Thinq2Connection(device)
        connection.mqtt.subscribe = (() =>
            Promise.reject(new Error('simulated preDeploy failure'))) as typeof connection.mqtt.subscribe

        let sawError = false
        connection.on('error', () => (sawError = true))
        let sawClose = false
        connection.on('close', () => (sawClose = true))

        await until(() => sawError, 'the preDeploy error')
        await untilAsync(
            async () => (await notes()).some((n) => n.kind === 'bridge-connection-closed'),
            "'close' firing because destroy() forced it - the actual fix",
        )
        assert.equal(sawClose, true)

        const allNotes = await notes()
        assert.ok(allNotes.some((n) => n.kind === 'bridge-connection-failed' && n.stage === 'preDeploy'))
        const closeNote = allNotes.find((n) => n.kind === 'bridge-connection-closed')
        assert.equal(closeNote?.connectedOnce, true)

        await new Promise((resolve) => server.close(resolve))
    })
})
