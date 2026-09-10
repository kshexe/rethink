import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/ML32PWFOTA'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'ML32PWFOTA'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

/*
 * Fixtures. All REAL frames, captured 2026-09-10 by driving my.lgthinq.com directly (with the
 * user's explicit go-ahead, since course-send never actually starts the oven - see
 * ML32PWFOTA.ts's file header) and reading rethink's on-box capture log for the same timestamps.
 */
const GRILL_DEFAULT_2000 = buf(
    'aa4cf04301010100000c0000e600000000006600000000000000000000000000000000000000000000000000000000000000000000000000000000010000040704020a01000004000000f0bb',
)
const GRILL_2105 = buf(
    'aa4cf04301010100000c4100e600000000006600000000000000000000000000000000000000000000000000000000000000000000000000000000010000040704020a01000004000000b3bb',
)
const GRILL_500 = buf(
    'aa4cf0430101010000030000e600000000006600000000000000000000000000000000000000000000000000000000000000000000000000000000010000040704020a01000004000000c9bb',
)
const MICROWAVE_DEFAULT_100 = buf(
    'aa4cf0430101010000003c000000000000006500000000000000000000000000000000000000000000000000000000000000000000000000000000010000000704020003000004000000b7bb',
)
const ACK_SEND = buf('aa084000430060bb')
const ACK_CANCEL = buf('aa084000440063bb')
const CANCEL_FRAME = buf('aa07f04400b0bb')

// `40 ec` state-echo frames, cross-checked against the official lg_thinq integration's own
// current_status/temperature sensors at the same instant - see ML32PWFOTA.ts's STATE section.
const STATE_IDLE_BASELINE = buf(
    'aa3e40ec000000000000000001000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000043bb',
)
const STATE_OVEN_PREFERENCE_180C = buf(
    'aa3e40ec00000000000000000100000000000000000000000000000000000000071300000000b4040000000000000000000000000000000000000000b2bb',
)
const STATE_OVEN_BACK_TO_IDLE = buf(
    'aa3e40ec071300000000b404000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000b2bb',
)
const STATE_MICROWAVE_PREFERENCE_0C = buf(
    'aa3e40ec000000000000000001000000000000000000000000000000000000000713000000000004000000000000000000000000000000000000000066bb',
)

// A real physical cook: the user queued a 10-second 레인지 run remotely, then pressed Start on
// the appliance itself and let it finish - see ML32PWFOTA.ts's "A REAL COOK" section. These 4
// frames are consecutive, real, in order.
const STATE_PRE_RUN = buf(
    'aa3e40ec000000000000000001000000000000000000000000000000000000000701000000000000000000000000000000000000000000000000000048bb',
)
const STATE_COOKING_10S = buf(
    'aa3e40ec0701000000000000000000000000000000000000000000000000000002010000000a000000000000000000000000000000000000000000007cbb',
)
const STATE_DONE = buf(
    'aa3e40ec02010000000a000000000000000000000000000000000000000000000500000000000000010000000000000000000000000000000000000072bb',
)
const STATE_DONE_BACK_TO_INITIAL = buf(
    'aa3e40ec05000000000000000100000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000004ebb',
)

// A second real cook, from a larger ~10-minute session of real runs: 오븐 at 185C, deliberately
// stopped with the physical Stop button while 5 seconds remained - confirms "paused" (0x04)
// against the official integration, which read "paused" at this exact moment.
const STATE_OVEN_COOKING_185 = buf(
    'aa3e40ec070400000000b900000000000000000000000000000000000000000002040000000ab9000000000000000000000000000000000000000000f4bb',
)
const STATE_OVEN_PAUSED_185 = buf(
    'aa3e40ec02040000000ab9000000000000000000000000000000000000000000040400000005b9000000000000000000000000000000000000000000f6bb',
)

// One of 5 real maintenance-menu runs (스팀청소탈취/스팀발생기세정/잔수제거/조리실건조/스팀청소,
// all triggered from the appliance's own panel, not anything this handler can send) - confirms
// "cleaning" (0x03) against the official integration.
const STATE_CLEANING = buf(
    'aa3e40ec07000000000000000000000000000000000000000000000000000000031201000b000000000000000000000000000000000000000000000069bb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('declares the course/time/send/cancel components', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components).sort(), [
            'cancel',
            'cook_time_minutes',
            'cook_time_seconds',
            'course',
            'current_status',
            'oven_temperature',
            'send',
        ])
        assert.deepEqual(components.course.options, ['구이', '레인지', '오븐', '스팀', '식품건조', '발효'])
    })

    test('starts on 구이 with its own 20:00 default, published on construction', () => {
        const { ha } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID].properties.course, '구이')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_minutes, 20)
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_seconds, 0)
    })

    test('send reproduces the real 구이 20:00 frame byte for byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('send', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), GRILL_DEFAULT_2000.toString('hex'))
    })

    test('changing the time then sending reproduces the real 21분5초 frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('cook_time_minutes', '21')
        dev.setProperty('cook_time_seconds', '5')
        thinq.resetRecorder()
        dev.setProperty('send', '')
        assert.equal(thinq.outbox[0].toString('hex'), GRILL_2105.toString('hex'))
    })

    test('changing the time then sending reproduces the real 5분0초 frame', () => {
        const { thinq, dev } = makeDevice()
        dev.setProperty('cook_time_minutes', '5')
        dev.setProperty('cook_time_seconds', '0')
        thinq.resetRecorder()
        dev.setProperty('send', '')
        assert.equal(thinq.outbox[0].toString('hex'), GRILL_500.toString('hex'))
    })

    test("switching course resets the time controls to that course's own default, and send reproduces the real 레인지 1:00 frame", () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('course', '레인지')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_minutes, 1)
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_seconds, 0)

        thinq.resetRecorder()
        dev.setProperty('send', '')
        assert.equal(thinq.outbox[0].toString('hex'), MICROWAVE_DEFAULT_100.toString('hex'))
    })

    test('cancel reproduces the real f0 44 00 frame byte for byte', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('cancel', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), CANCEL_FRAME.toString('hex'))
    })

    test('cook_time_minutes and cook_time_seconds are clamped to the real confirmed ranges', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('cook_time_minutes', '999')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_minutes, 50, 'clamped to max 50')
        dev.setProperty('cook_time_minutes', '-5')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_minutes, 0, 'clamped to min 0')
        dev.setProperty('cook_time_seconds', '58')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_seconds, 55, 'snaps to 60 then clamps to max 55')
    })

    test('cook_time_seconds snaps to the nearest confirmed 5-second step', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('cook_time_seconds', '7')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_seconds, 5, '7 snaps down to 5')
        dev.setProperty('cook_time_seconds', '53')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_seconds, 55, '53 snaps up to 55')
    })

    test('the send and cancel acks are recognised and publish nothing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ACK_SEND)
        thinq.emit('data', ACK_CANCEL)
        assert.equal(ha.devices[DEVICE_ID].properties.course, '구이', 'unchanged by an ack')
    })

    test('declares the current_status and oven_temperature sensors', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.equal(components.current_status.platform, 'sensor')
        assert.equal(components.oven_temperature.platform, 'sensor')
        assert.equal(components.oven_temperature.unit_of_measurement, '°C')
    })

    test('the idle baseline state frame publishes initial / no temperature', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_IDLE_BASELINE)
        assert.equal(ha.devices[DEVICE_ID].properties.current_status, 'initial')
        assert.equal(ha.devices[DEVICE_ID].properties.oven_temperature, 0)
    })

    test('a send-then-cancel round trip publishes preference/180C then back to initial/0', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_OVEN_PREFERENCE_180C)
        assert.equal(ha.devices[DEVICE_ID].properties.current_status, 'preference')
        assert.equal(ha.devices[DEVICE_ID].properties.oven_temperature, 180)

        thinq.emit('data', STATE_OVEN_BACK_TO_IDLE)
        assert.equal(ha.devices[DEVICE_ID].properties.current_status, 'initial')
        assert.equal(ha.devices[DEVICE_ID].properties.oven_temperature, 0)
    })

    test('레인지 (no temperature) still flips status to preference, confirming the two fields are independent', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_MICROWAVE_PREFERENCE_0C)
        assert.equal(ha.devices[DEVICE_ID].properties.current_status, 'preference')
        assert.equal(ha.devices[DEVICE_ID].properties.oven_temperature, 0)
    })

    test('a real physical cook publishes cooking_in_progress then done, matching the official integration', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_PRE_RUN)
        assert.equal(ha.devices[DEVICE_ID].properties.current_status, 'preference')
        thinq.emit('data', STATE_COOKING_10S)
        assert.equal(ha.devices[DEVICE_ID].properties.current_status, 'cooking_in_progress')
        thinq.emit('data', STATE_DONE)
        assert.equal(ha.devices[DEVICE_ID].properties.current_status, 'done')
        thinq.emit('data', STATE_DONE_BACK_TO_INITIAL)
        assert.equal(
            ha.devices[DEVICE_ID].properties.current_status,
            'initial',
            'falls back on its own, no user action needed',
        )
    })

    test('stopping a real cook mid-run publishes paused, and temperature stays at the real target (185C)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_OVEN_COOKING_185)
        assert.equal(ha.devices[DEVICE_ID].properties.current_status, 'cooking_in_progress')
        assert.equal(ha.devices[DEVICE_ID].properties.oven_temperature, 185)
        thinq.emit('data', STATE_OVEN_PAUSED_185)
        assert.equal(ha.devices[DEVICE_ID].properties.current_status, 'paused')
        assert.equal(ha.devices[DEVICE_ID].properties.oven_temperature, 185)
    })

    test('a real maintenance-menu run (steam clean etc.) publishes cleaning', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_CLEANING)
        assert.equal(ha.devices[DEVICE_ID].properties.current_status, 'cleaning')
    })
})
