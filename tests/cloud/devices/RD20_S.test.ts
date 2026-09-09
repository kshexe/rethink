import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/RD20_S'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RD20_S'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

/*
 * Fixtures. All REAL frames, captured 2026-09-09 against a real unit by clicking the power
 * switch on my.lgthinq.com and reading rethink's on-box capture log
 * (/share/rethink/frames/<date>.jsonl) for the same timestamp - see RD20_S.ts's file header.
 */
const ACK = buf('aa083000e50092bb')
// The 63-byte from-device frame that follows the ack. Looks like a power echo at a glance - it
// is not one, see the file header - so this handler must treat it the same as any other
// unrecognised frame rather than reading (wrongly) that power is off.
const BUNDLED_STATUS = buf(
    'aa3f30e6000201ff0102000000000000000000000000000000010000000000000000002000008007000000000000000000000000000000000000000000f9bb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('declares exactly one writable component: power', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components), ['power'])
        assert.equal(components.power.command_topic, '$this/power/set')
    })

    test('power write reproduces the captured frame byte for byte', () => {
        for (const [value, want] of [
            ['ON', 'aa0df0e5000201ff010201c7bb'],
            ['OFF', 'aa0df0e5000201ff010200c4bb'],
        ] as [string, string][]) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty('power', value)
            assert.equal(thinq.outbox.length, 1, `power=${value} sent one frame`)
            assert.equal(thinq.outbox[0].toString('hex'), want, `power=${value}`)
        }
    })

    test('power is published optimistically as soon as it is set, not waiting on a device echo', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('power', 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        dev.setProperty('power', 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
    })

    test('the ack frame is accepted and publishes nothing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ACK)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('the bundled status frame does not get misread as power state', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('power', 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
        // If this frame were (wrongly) parsed as a power echo it would publish OFF here, since
        // its state-shaped byte reads 0x00 regardless of the appliance's real power state - see
        // the file header. It must not move the property at all.
        thinq.emit('data', BUNDLED_STATUS)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'ON')
    })
})
