import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/2REF21EBNSX_3'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REF21EBNSX_3'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

/*
 * Fixtures. All REAL frames, captured 2026-09-10 against a real unit by sweeping each control
 * through its full real range via the lg_thinq HA integration and my.lgthinq.com, and reading
 * rethink's on-box capture log (/share/rethink/frames/<date>.jsonl) for the same timestamps -
 * see 2REF21EBNSX_3.ts's file header.
 */
const ACK = buf('aa08100017008cbb')
// The "10 ec" state frame that followed the fridge_temp=7 write in the real sweep: old record
// (fridge=4, freezer raw=4, express=1) then new record (fridge=7, freezer raw=4, express=1).
const STATE_FRIDGE_7 = buf('aa2a10ec020404010700ff00010001ffffffffffff01020704010700ff00010001ffffffffffff01babb')
// Followed express_freeze=ON: old record (fridge=4, freezer raw=4, express=1) then new (express=2).
const STATE_EXPRESS_ON = buf('aa2a10ec020404010700ff00010001ffffffffffff01020404020700ff00010001ffffffffffff01b8bb')
// The query frame this handler sends, and a real "eb" query response (fridge=4, freezer raw=4,
// express=1) captured mid-day, unrelated to any write of ours - see the file header.
const QUERY_FRAME_HEX = 'aa0ef0ed1211010000010400ebbb'
const QUERY_RESPONSE = buf('aa1810eb020404010700ff00010001ffffffffffff019ebb')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('declares the three writable components', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components).sort(), ['express_freeze', 'freezer_temp', 'fridge_temp'])
        assert.equal(components.fridge_temp.min, 1)
        assert.equal(components.fridge_temp.max, 7)
        assert.equal(components.freezer_temp.min, -23)
        assert.equal(components.freezer_temp.max, -15)
    })

    test('fridge_temp write reproduces the captured frame byte for byte', () => {
        for (const [value, want] of [
            ['7', 'aa2ff017ff07ffffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff93bb'],
            ['1', 'aa2ff017ff01ffffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff95bb'],
            ['4', 'aa2ff017ff04ffffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff96bb'],
        ] as [string, string][]) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty('fridge_temp', value)
            assert.equal(thinq.outbox.length, 1, `fridge_temp=${value} sent one frame`)
            assert.equal(thinq.outbox[0].toString('hex'), want, `fridge_temp=${value}`)
        }
    })

    test('freezer_temp write reproduces the captured frame byte for byte (raw = -14 - degC)', () => {
        for (const [value, want] of [
            ['-23', 'aa2ff017ffff09ffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff9dbb'],
            ['-15', 'aa2ff017ffff01ffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff95bb'],
            ['-18', 'aa2ff017ffff04ffffffffff01ffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff96bb'],
        ] as [string, string][]) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty('freezer_temp', value)
            assert.equal(thinq.outbox.length, 1, `freezer_temp=${value} sent one frame`)
            assert.equal(thinq.outbox[0].toString('hex'), want, `freezer_temp=${value}`)
        }
    })

    test('express_freeze write reproduces the captured frame byte for byte', () => {
        for (const [value, want] of [
            ['ON', 'aa2ff017ffffff02ffffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffffeabb'],
            ['OFF', 'aa2ff017ffffff01ffffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffffebbb'],
        ] as [string, string][]) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty('express_freeze', value)
            assert.equal(thinq.outbox.length, 1, `express_freeze=${value} sent one frame`)
            assert.equal(thinq.outbox[0].toString('hex'), want, `express_freeze=${value}`)
        }
    })

    test('setpoints are clamped to the real confirmed range', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('fridge_temp', '99')
        assert.equal(thinq.outbox[0].subarray(5, 6).toString('hex'), '07', 'clamped to max 7')
        thinq.resetRecorder()
        dev.setProperty('freezer_temp', '-99')
        assert.equal(thinq.outbox[0].subarray(6, 7).toString('hex'), '09', 'clamped to -23 (raw 9)')
    })

    test('all three are published optimistically as soon as they are set', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('fridge_temp', '5')
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_temp, 5)
        dev.setProperty('freezer_temp', '-20')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_temp, -20)
        dev.setProperty('express_freeze', 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'ON')
    })

    test('the ack frame is accepted and publishes nothing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ACK)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_temp, undefined)
    })

    test('the state frame publishes the real reading, from the second (current) record', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_FRIDGE_7)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_temp, 7)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_temp, -18, 'raw 4 -> -14-4=-18')
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'OFF', 'raw 1 -> off')
    })

    test('a real reading corrects an optimistic guess that turns out wrong', () => {
        const { ha, thinq, dev } = makeDevice()
        // Optimistic guess says ON...
        dev.setProperty('express_freeze', 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'ON')
        // ...but STATE_FRIDGE_7's current record reports express raw=1 (off) - the real reading
        // must win over the optimistic guess.
        thinq.emit('data', STATE_FRIDGE_7)
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'OFF')
    })

    test('the state frame is read from the second record even when unrelated fields are present', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_EXPRESS_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_temp, 4)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_temp, -18)
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'ON')
    })

    test('start() sends the query frame immediately, byte for byte, and again on a timer', (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.start()
        assert.equal(thinq.outbox.length, 1, 'queried once on start')
        assert.equal(thinq.outbox[0].toString('hex'), QUERY_FRAME_HEX)

        tickMockTimers(t, 5 * 60 * 1000)
        assert.equal(thinq.outbox.length, 2, 'queried again after the interval')
        assert.equal(thinq.outbox[1].toString('hex'), QUERY_FRAME_HEX)

        dev.drop()
    })

    test('drop() stops the query timer - no further queries after that', (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        dev.start()
        thinq.resetRecorder()

        dev.drop()
        tickMockTimers(t, 60 * 60 * 1000)
        assert.equal(thinq.outbox.length, 0, 'no query fired after drop()')
    })

    test('the query response (a single record, not a before/after pair) publishes the real reading', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', QUERY_RESPONSE)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_temp, 4)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_temp, -18)
        assert.equal(ha.devices[DEVICE_ID].properties.express_freeze, 'OFF')
    })
})
