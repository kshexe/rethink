import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/H01'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'H01'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

/*
 * Fixtures. All REAL frames, captured 2026-09-10 against a real unit by clicking the power
 * switch on my.lgthinq.com and reading rethink's on-box capture log
 * (/share/rethink/frames/<date>.jsonl) for the same timestamp - see H01.ts's file header.
 */
const ACK = buf('aa08320026005fbb')

// Real 0xEC dual-record status frame, captured 2026-09-13 turning the appliance on into its
// default course ("표준", showing "55분" on the appliance's own display) - see H01.ts's file
// header STATUS RECORD section.
const STATUS_EC_STANDARD_55MIN = buf(
    'aa3a32ec001800000000370000003700005000000009915f00000000000c' +
        '00180100000037050000370000520000000b935f00000000000c91bb',
)

// Real 0xEB single-record query response, captured while the appliance sat idle/off with
// "표준" (55분) as its last-used course.
const STATUS_EB_OFF_55MIN = buf('aa2032eb001804000000370000000100000200000002805f00000000000c7fbb')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('declares power as the only writable component; the rest are read-only sensors', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components), [
            'power',
            'duration_minutes',
            'course_index',
            'reservation_hours',
            'steam',
            'intensive_wash_top',
            'intensive_wash_bottom',
            'high_temp_sterilize',
            'extra_rinse',
            'hot_air_dry_minutes',
        ])
        assert.equal(components.power.command_topic, '$this/power/set')
        for (const key of Object.keys(components)) {
            if (key === 'power') continue
            assert.equal(components[key].command_topic, undefined, `${key} has no command_topic`)
        }
    })

    test('power write reproduces the captured frame byte for byte', () => {
        for (const [value, want] of [
            ['ON', 'aa07f0261688bb'],
            ['OFF', 'aa07f026128cbb'],
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

    test('a real 0xEC status frame decodes power/duration/course/options', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_EC_STANDARD_55MIN)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.duration_minutes, 55)
        assert.equal(props.course_index, 5)
        assert.equal(props.reservation_hours, 0)
        assert.equal(props.steam, 'OFF')
        assert.equal(props.intensive_wash_top, 'OFF')
        assert.equal(props.intensive_wash_bottom, 'OFF')
        assert.equal(props.high_temp_sterilize, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.hot_air_dry_minutes, 0)
    })

    test('a real 0xEB query response decodes the same way as an 0xEC record', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_EB_OFF_55MIN)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.duration_minutes, 55)
        assert.equal(props.course_index, 0)
    })
})
