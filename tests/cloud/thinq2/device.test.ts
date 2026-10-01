// 2026-09-29's 안방에어컨 stall (see RETHINK memory `rethink-migration-status`) went undiagnosed
// because nothing recorded *why* its connection ended - every exit from DeviceAcceptor.disconnected()
// was silent, and by the time anyone noticed the device was gone, the live log's rolling window had
// long since moved past it. This file covers the fix: a `reason` now travels from wherever a
// connection actually ends (the raw close/error/disconnect, or the broker's own idle timeout) all the
// way to a note() call that lands in the same frame log the appliance's own traffic does, so it
// survives long enough to read.

import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Broker, type PublishPacket } from '@/cloud/mqtt-broker'
import { DeviceAcceptor, Device } from '@/cloud/thinq2/device'
import * as frameRecorder from '@/cloud/frame-recorder'

/** Everything `Client` actually calls on the object `mqtt-connection` would normally hand it. */
class FakeMqttConnection extends EventEmitter {
    connack() {}
    puback() {}
    pingresp() {}
    suback() {}
    unsuback() {}
    destroy() {}
}

describe('Client.destroy() reason threading', () => {
    test('a raw close carries "close"', () => {
        const mqtt = new FakeMqttConnection()
        const client = new Client(mqtt as never, new Map<string, PublishPacket>())
        let reason: string | undefined
        client.on('destroy', (_will, r) => (reason = r))

        mqtt.emit('close')

        assert.equal(reason, 'close')
    })

    test('a socket error carries the error itself, not just the fact there was one', () => {
        const mqtt = new FakeMqttConnection()
        const client = new Client(mqtt as never, new Map<string, PublishPacket>())
        let reason: string | undefined
        client.on('destroy', (_will, r) => (reason = r))

        mqtt.emit('error', new Error('ECONNRESET'))

        assert.match(reason!, /ECONNRESET/)
    })

    test('an explicit MQTT disconnect packet is distinguishable from a dead socket', () => {
        const mqtt = new FakeMqttConnection()
        const client = new Client(mqtt as never, new Map<string, PublishPacket>())
        let reason: string | undefined
        client.on('destroy', (_will, r) => (reason = r))

        mqtt.emit('disconnect')

        assert.equal(reason, 'disconnect packet')
    })

    test('a caller-supplied reason (the broker idle timeout, a shutdown signal) passes through unchanged', () => {
        const mqtt = new FakeMqttConnection()
        const client = new Client(mqtt as never, new Map<string, PublishPacket>())
        let reason: string | undefined
        client.on('destroy', (_will, r) => (reason = r))

        client.destroy('idle timeout (5 min)')

        assert.equal(reason, 'idle timeout (5 min)')
    })

    test('destroying twice only fires once - the second call is a no-op, not a second reason', () => {
        const mqtt = new FakeMqttConnection()
        const client = new Client(mqtt as never, new Map<string, PublishPacket>())
        const reasons: string[] = []
        client.on('destroy', (_will, r) => reasons.push(r))

        client.destroy('close')
        client.destroy('error: should not fire')

        assert.deepEqual(reasons, ['close'])
    })
})

describe('Broker re-emits the reason on disconnect', () => {
    test("the idle timeout's own reason reaches the broker's 'disconnect' listeners", () => {
        const mqtt = new FakeMqttConnection()
        const client = new Client(mqtt as never, new Map<string, PublishPacket>())
        const broker = new Broker()
        let reason: string | undefined
        broker.on('disconnect', (_client, r) => (reason = r))

        // Exercises the same path Broker.accept()'s `client.on('destroy', ...)` wires up, without
        // needing a real net.Socket for the stream-level timeout itself.
        broker.clients.add(client)
        client.on('destroy', (lwt, r) => broker.emit('disconnect', client, r))
        client.destroy('idle timeout (5 min)')

        assert.equal(reason, 'idle timeout (5 min)')
    })
})

describe('DeviceAcceptor.disconnected() records the reason where it survives', () => {
    let dir: string

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'rethink-disconnect-test-'))
        frameRecorder.configure({ dir, days: 1 })
    })

    afterEach(() => {
        frameRecorder.configure({ dir: '/share/rethink/frames', days: 0 }) // back to disabled
        rmSync(dir, { recursive: true, force: true })
    })

    test('a note lands in the frame log naming the device and the reason', async () => {
        const broker = new Broker()
        const acceptor = new DeviceAcceptor(broker)
        const meta = { modelId: 'CST_570004_WW', modelName: 'TEST', swVersion: '1.0' }
        const dev = new Device(broker, 'lime/devices/test-id', 'test-id', meta)
        const client = { deviceObj: dev } as unknown as Client

        acceptor.clientsById['test-id'] = client
        let dropped: string | undefined
        acceptor.on('dropDevice', (id) => (dropped = id))
        let deviceSawClose = false
        dev.on('close', () => (deviceSawClose = true))

        acceptor.disconnected(client, 'idle timeout (5 min)')

        assert.equal(acceptor.clientsById['test-id'], undefined, 'the id is freed for a future reconnect')
        assert.equal(dropped, 'test-id')
        assert.ok(deviceSawClose, "the device's own close handler still runs - this is additive, not a replacement")

        // note() appends through frame-recorder's own promise chain (see its file header) rather
        // than writing synchronously - same wait tests/cloud/frame-recorder.test.ts already uses.
        await new Promise((r) => setTimeout(r, 50))

        const today = new Date().toISOString().slice(0, 10)
        const lines = readFileSync(join(dir, `${today}.jsonl`), 'utf-8')
            .trim()
            .split('\n')
        const note = JSON.parse(lines[lines.length - 1])
        assert.equal(note.id, 'test-id')
        assert.equal(note.model, 'CST_570004_WW')
        assert.equal(note.kind, 'disconnected')
        assert.equal(note.reason, 'idle timeout (5 min)')
    })

    test('a client with no device attached yet (dropped mid-provisioning) writes nothing and does not throw', () => {
        const broker = new Broker()
        const acceptor = new DeviceAcceptor(broker)
        const client = { deviceObj: undefined } as unknown as Client

        assert.doesNotThrow(() => acceptor.disconnected(client, 'close'))
    })
})
