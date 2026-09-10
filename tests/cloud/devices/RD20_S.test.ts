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

/*
 * 114-byte status frames, mined from a real dry cycle already sitting in the frame log (no fresh
 * test cycle run for this), cross-referenced against the official lg_thinq integration's own
 * sensors for the same timestamps - see RD20_S.ts's REMAINING_MINUTES section, including the
 * correction recorded there: a first pass mistook this field for a status enum by only checking
 * it against sensor.geonjogi_current_status; checking it against sensor.geonjogi_remaining_time
 * across more of the same cycle showed it is just the plain minutes-remaining countdown. Each
 * constant here is the full captured frame (`thinq.emit('data', <full frame>)` needs the outer
 * `aa ff ... <ck> bb` envelope; AABBDevice strips it before handing `buf` to processAABB).
 */
const STATE_99_MIN_LEFT = buf(
    'aaff300a007600d9e5000100ec006400000200002c00000000640064070e00020001041c000000000041800700000000000000000000000000000000000000000000000200002c00000000630064070e00020003041c00000000004180070000000000000000000000000000000000000000002863bb',
)
const STATE_74_MIN_LEFT = buf(
    'aaff300a007600dc80000100ec006400000200002c00000000490064070e00030145041c000000000041800700000000000000000000000000000000000000000000000200002c000000004a0064070e0003014f041c0000000000418007000000000000000000000000000000000000000000ab92bb',
)
// One frame whose old/new pair alone shows the countdown moving, 58 -> 11 minutes left (the big
// jump is real - it lands right at the transition into the short, fixed-length cooling stage).
const STATE_58_TO_11_MIN_LEFT = buf(
    'aaff300a007600de41000100ec006400000200002c000000003a0064070e000301ff041c000000000041800700000000000000000000000000000000000000000000000200002c000000000b0064070e00040214041c00000000004180070000000000000000000000000000000000000000005dc7bb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('declares power and remaining_minutes', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components), ['power', 'remaining_minutes'])
        assert.equal(components.power.command_topic, '$this/power/set')
        assert.equal(components.remaining_minutes.platform, 'sensor')
        assert.equal(components.remaining_minutes.unit_of_measurement, 'min')
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

    test('the 114-byte status frame publishes remaining_minutes, matching the official integration', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_99_MIN_LEFT)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_minutes, 99)
        thinq.emit('data', STATE_74_MIN_LEFT)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_minutes, 74)
        thinq.emit('data', STATE_58_TO_11_MIN_LEFT)
        assert.equal(
            ha.devices[DEVICE_ID].properties.remaining_minutes,
            11,
            'reads the second (current) record, not the first',
        )
    })
})
