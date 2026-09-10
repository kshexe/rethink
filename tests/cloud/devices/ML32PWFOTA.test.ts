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

// A dedicated, one-course-at-a-time follow-up session: the user started each real course in turn,
// reporting it live - see ML32PWFOTA.ts's ACTIVE COURSE AND REMAINING TIME section. Each of these
// is the "cooking_in_progress" frame from one such run.
const STATE_RANGE_COOKING_30S = buf(
    'aa3e40ec0000000000000000010000000000000000000000000000000000000002010000001e0000000000000000000000000000000000000000000063bb',
)
const STATE_GRILL_COOKING_20MIN = buf(
    'aa3e40ec07030000010300000000000000000000000000000000000000000000020300001400000000000000000000000000000000000000000000006ebb',
)
const STATE_FERMENT_COOKING_1H15M = buf(
    'aa3e40ec071500053b3428000000000000000000000000000000000000000000021500010f00280000000000000000000000000000000000000000004ebb',
)
const STATE_STEAM_FERMENT_COOKING_9H = buf(
    'aa3e40ec07160000001d2800000000000000000000000000000000000000000002160009000028000000000000000000000000000000000000000000eabb',
)

// All 5 of the appliance's own maintenance functions, run live one at a time - see ML32PWFOTA.ts's
// ACTIVE CLEANING FUNCTION section. record[1] reads the same 0x12 "cleaning" marker in every one
// (not a course id), and record[3] - "hours remaining" while actually cooking - is repurposed as
// the function id here instead.
const STATE_DEODORIZE_COOKING_11MIN = buf(
    'aa3e40ec07000000000000000000000000000000000000000000000000000000031201000b000000000000000000000000000000000000000000000069bb',
)
const STATE_STEAM_CLEAN_PAUSED = buf(
    'aa3e40ec031202000f0000000000000000000000000000000000000000000000041202000e3900000000000000000000000000000000000000000000ccbb',
)
const STATE_CAVITY_DRY_COOKING_12MIN = buf(
    'aa3e40ec07000000000000000000000000000000000000000000000000000000031203000c00000000000000000000000000000000000000000000006abb',
)
const STATE_RESIDUAL_WATER_PAUSED = buf(
    'aa3e40ec0312040004000000000000000000000000000000000000000000000004120400033a00000000000000000000000000000000000000000000ddbb',
)
const STATE_STEAM_GENERATOR_CLEAN_PAUSED = buf(
    'aa3e40ec0312050017000000000000000000000000000000000000000000000004120500163a00000000000000000000000000000000000000000000e5bb',
)
// Real capture (2026-09-10): a genuine built-in 자동요리 recipe (레인지 category, id 8/1 =
// 감자삶기 0.8kg) starting - 13:00 default. See decodeCourseId's header comment.
const STATE_AUTOCOOK_POTATO = buf(
    'aa3e40ec07080100000000000000000000000000000000000000000000000000020801000d000000000000000000000000000000000000000000000069bb',
)
// Real capture (2026-09-10): remote-sent 레인지/10s via HA, resent after an odd ack. Confirmed
// live that a remote send doesn't land on a plain manual course - LG's firmware replays it
// through a saved "나만의 레시피"(my recipe) slot instead, record[1] pinned at 0x13 regardless of
// which manual course was actually picked before sending. See MY_RECIPE_MARKER's header comment.
const STATE_AUTOCOOK_REMOTE_SEND_10S = buf(
    'aa3e40ec0713000000130004000000000000000000000000000000000000000002130000000a000400000000000000000000000000000000000000003dbb',
)
// Real capture (2026-09-10): remote-sent 구이/10s via HA - a third remote send (after 오븐, then
// 레인지), used only to disprove that record[7] tracks the live course selection (it read `4` -
// 오븐's id - in all three, including this 구이 one).
const STATE_AUTOCOOK_REMOTE_SEND_GRILL_10S = buf(
    'aa3e40ec00130000000000040100000000000000000000000000000000000000071300000004000400000000000000000000000000000000000000001bbb',
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
            'active_cleaning_function',
            'active_course',
            'cancel',
            'cook_time_minutes',
            'cook_time_seconds',
            'course',
            'current_status',
            'oven_temperature',
            'remaining_time',
            'send',
            'target_temperature',
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

    test("cook_time is clamped to the selected course's own real range (구이: 10s-50min)", () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('cook_time_minutes', '999')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_minutes, 50, 'clamped to max 50 min')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_seconds, 0)

        dev.setProperty('cook_time_minutes', '-5')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_minutes, 0, 'clamped to min 10s, not 0')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_seconds, 10)

        // 58 snaps to 60 (nearest 5s step), which is a valid total for 구이 - no longer clamped
        // down to 55, since the real limit is the course's own max (50 min), not a fixed per-field
        // ceiling.
        dev.setProperty('cook_time_seconds', '58')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_minutes, 1)
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_seconds, 0)
    })

    test('cook_time respects a much narrower course range (스팀: 10s-30min) and a course that allows 0 (오븐)', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('course', '스팀')
        dev.setProperty('cook_time_minutes', '999')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_minutes, 30, "clamped to 스팀's own 30-minute max")

        dev.setProperty('course', '오븐')
        dev.setProperty('cook_time_minutes', '0')
        dev.setProperty('cook_time_seconds', '0')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_minutes, 0)
        assert.equal(
            ha.devices[DEVICE_ID].properties.cook_time_seconds,
            0,
            '0 is real and valid for 오븐 (preheat-only), not clamped up to a minimum',
        )
    })

    test('cook_time allows multi-hour totals for 식품건조/발효 (5min-9h)', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('course', '식품건조')
        dev.setProperty('cook_time_minutes', '999')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_minutes, 540, 'clamped to 9 hours (540 min), not 50')

        dev.setProperty('cook_time_minutes', '1')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_minutes, 5, 'clamped up to the 5-minute minimum')
    })

    test('cook_time_seconds snaps to the nearest confirmed 5-second step', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('cook_time_seconds', '7')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_seconds, 5, '7 snaps down to 5')
        dev.setProperty('cook_time_seconds', '53')
        assert.equal(ha.devices[DEVICE_ID].properties.cook_time_seconds, 55, '53 snaps up to 55')
    })

    test("switching course resets target_temperature to that course's own default - 0 for a course with no adjustable range, its real default otherwise", () => {
        const { ha, dev } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID].properties.target_temperature, 0, '구이 has no adjustable range')

        dev.setProperty('course', '오븐')
        assert.equal(ha.devices[DEVICE_ID].properties.target_temperature, 180)

        dev.setProperty('course', '식품건조')
        assert.equal(ha.devices[DEVICE_ID].properties.target_temperature, 40)

        dev.setProperty('course', '레인지')
        assert.equal(ha.devices[DEVICE_ID].properties.target_temperature, 0)
    })

    test("target_temperature is clamped to the selected course's own real range (오븐: 100-230°C, 식품건조: 40-90°C)", () => {
        const { ha, dev } = makeDevice()

        dev.setProperty('course', '오븐')
        dev.setProperty('target_temperature', '999')
        assert.equal(ha.devices[DEVICE_ID].properties.target_temperature, 230, 'clamped to max 230')
        dev.setProperty('target_temperature', '0')
        assert.equal(ha.devices[DEVICE_ID].properties.target_temperature, 100, 'clamped to min 100')

        dev.setProperty('course', '식품건조')
        dev.setProperty('target_temperature', '150')
        assert.equal(ha.devices[DEVICE_ID].properties.target_temperature, 90, 'clamped to max 90')
    })

    test('a course with no adjustable temperature ignores target_temperature entirely - it always reads back 0', () => {
        const { ha, dev } = makeDevice()
        for (const course of ['구이', '레인지', '스팀', '발효']) {
            dev.setProperty('course', course)
            dev.setProperty('target_temperature', '150')
            assert.equal(ha.devices[DEVICE_ID].properties.target_temperature, 0, `${course} has no adjustable range`)
        }
    })

    // UNVERIFIED against a real send - see buildCourseFrame's comment: only the time offsets
    // (inner[7]/[8]) have been confirmed against real captures so far, inner[10] has not.
    test("send writes the clamped target_temperature into inner[10] for a course with an adjustable range, leaving other courses' captured default untouched", () => {
        const { thinq, dev } = makeDevice()

        dev.setProperty('course', '오븐')
        dev.setProperty('target_temperature', '200')
        thinq.resetRecorder()
        dev.setProperty('send', '')
        assert.equal(
            thinq.outbox[0].subarray(12, 13).toString('hex'),
            'c8',
            '200 decimal = 0xc8, at inner[10] = frame byte 12',
        )

        dev.setProperty('course', '구이')
        thinq.resetRecorder()
        dev.setProperty('send', '')
        assert.equal(
            thinq.outbox[0].toString('hex'),
            GRILL_DEFAULT_2000.toString('hex'),
            '구이 has no adjustable range - byte-for-byte identical to the real captured frame, inner[10] included',
        )
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

    test('active_course and remaining_time match real single-course runs, across the full time range', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', STATE_RANGE_COOKING_30S)
        assert.equal(ha.devices[DEVICE_ID].properties.active_course, '레인지')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 30)

        thinq.emit('data', STATE_GRILL_COOKING_20MIN)
        assert.equal(ha.devices[DEVICE_ID].properties.active_course, '구이')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 20 * 60)

        thinq.emit('data', STATE_FERMENT_COOKING_1H15M)
        assert.equal(ha.devices[DEVICE_ID].properties.active_course, '발효')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 1 * 3600 + 15 * 60)

        thinq.emit('data', STATE_STEAM_FERMENT_COOKING_9H)
        assert.equal(ha.devices[DEVICE_ID].properties.active_course, '스팀발효')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 9 * 3600)
    })

    test('oven_temperature is suppressed (not published as a misleading 0.0) for a course confirmed to never carry one - 레인지/구이 here, real captures both', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', STATE_RANGE_COOKING_30S)
        assert.equal(
            ha.devices[DEVICE_ID].properties.oven_temperature,
            'None',
            '레인지 has no temperature concept at all',
        )

        thinq.emit('data', STATE_GRILL_COOKING_20MIN)
        assert.equal(ha.devices[DEVICE_ID].properties.oven_temperature, 'None', '구이 likewise')

        // 발효 DOES carry a real temperature (40°C, confirmed live) unlike 레인지/구이/스팀/스팀레인지 -
        // switching to it should publish the real value again, not stay suppressed.
        thinq.emit('data', STATE_FERMENT_COOKING_1H15M)
        assert.equal(ha.devices[DEVICE_ID].properties.oven_temperature, 40)
    })

    test('active_course and remaining_time are not published while merely queued (preference)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_OVEN_PREFERENCE_180C)
        assert.equal(ha.devices[DEVICE_ID].properties.active_course, undefined)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, undefined)
    })

    test('active_cleaning_function identifies all 5 real maintenance runs, not active_course', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', STATE_DEODORIZE_COOKING_11MIN)
        assert.equal(ha.devices[DEVICE_ID].properties.active_cleaning_function, '스팀청소탈취')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 11 * 60)
        assert.equal(
            ha.devices[DEVICE_ID].properties.active_course,
            undefined,
            'record[1] is the cleaning marker, not a course id',
        )

        thinq.emit('data', STATE_STEAM_CLEAN_PAUSED)
        assert.equal(ha.devices[DEVICE_ID].properties.active_cleaning_function, '스팀청소')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 14 * 60 + 57)

        thinq.emit('data', STATE_CAVITY_DRY_COOKING_12MIN)
        assert.equal(ha.devices[DEVICE_ID].properties.active_cleaning_function, '조리실건조')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 12 * 60)

        thinq.emit('data', STATE_RESIDUAL_WATER_PAUSED)
        assert.equal(ha.devices[DEVICE_ID].properties.active_cleaning_function, '잔수제거')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 3 * 60 + 58)

        thinq.emit('data', STATE_STEAM_GENERATOR_CLEAN_PAUSED)
        assert.equal(ha.devices[DEVICE_ID].properties.active_cleaning_function, '스팀발생기세정')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 22 * 60 + 58)
    })

    test('any of the ~30 built-in auto-cook recipes reports active_course as a generic 자동요리, not a specific recipe name', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_AUTOCOOK_POTATO)
        assert.equal(ha.devices[DEVICE_ID].properties.active_course, '자동요리')
    })

    test('a remote send lands on the custom-recipe slot, reported as "내가 만든 레시피" (matches the appliance\'s own display, confirmed live) separately from 자동요리 (its underlying course is not recoverable - record[7] stays 4 no matter what was actually sent)', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', STATE_AUTOCOOK_REMOTE_SEND_10S)
        assert.equal(ha.devices[DEVICE_ID].properties.active_course, '내가 만든 레시피')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 10)

        thinq.emit('data', STATE_AUTOCOOK_REMOTE_SEND_GRILL_10S)
        assert.equal(
            ha.devices[DEVICE_ID].properties.active_course,
            '내가 만든 레시피',
            'same bucket regardless of which course was actually sent (구이 this time, not 오븐)',
        )
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_time, 10)
    })
})
