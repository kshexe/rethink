import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DUT from '@/cloud/devices/RD20_S'
import type { Metadata } from '@/cloud/thinq'
import { configure as configureEnergyAccumulator } from '@/cloud/energy-accumulator'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'RD20_S'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

/** energy-accumulator.ts persists to disk and caches by device id - point it at a fresh scratch
 *  dir (which also clears its cache) so each energy test starts from nothing, the same way
 *  tests/cloud/frame-recorder.test.ts isolates itself, and so these tests never touch the real
 *  /share/rethink/energy path. */
function freshEnergyDir() {
    const dir = mkdtempSync(join(tmpdir(), 'rd20s-energy-test-'))
    configureEnergyAccumulator(dir)
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
}

/** recordEnergyDelta() is fire-and-forget (`void ...`) from processAABB, so its file I/O has not
 *  necessarily landed yet the instant `thinq.emit` returns - give it a beat. */
async function settle() {
    await new Promise((r) => setTimeout(r, 50))
}

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

/*
 * Real 114-byte status frames mined from two separate complete dry cycles (2026-09-09 and
 * 2026-09-11), showing the STATUS byte's three confirmed values in order - see RD20_S.ts's STATUS
 * section. STATUS_RUNNING_18_MIN_LEFT and STATUS_COOLING_5_MIN_LEFT are consecutive frames from
 * the 2026-09-11 cycle (18 -> 5 min is the same discontinuous re-estimate jump documented for
 * remaining_minutes, landing on the exact frame the status flips running -> cooling).
 * STATUS_COMPLETE_1_MIN_LEFT is a different frame (same cycle) where the "new" record's copy of
 * the field reads complete - most captures of this transient value only carry it in the "old"
 * copy by the time rethink polls, this is one of the two found with it in the "new" one instead.
 */
const STATUS_RUNNING_18_MIN_LEFT = buf(
    'aaff300a00760072e4000100ec006400000200002c000000001300820710000404f9041c000000000041800700000000000000000000000000000000000000000000000200002c00000000120082071000040501041c00000000004180070000000000000000000000000000000000000000000675bb',
)
const STATUS_COOLING_5_MIN_LEFT = buf(
    'aaff300a00760073fa000100ec006400000200002c0000000006008211070005056d041c000000000061800700000000000000000000000000000000000000000000000200002c0000000005008211070005056f041c0000000000618007000000000000000000000000000000000000000000889fbb',
)
const STATUS_COMPLETE_1_MIN_LEFT = buf(
    'aaff300a007600744b000100ec006400000200002c00000000010082081100050577041c000000000041800700000000000000000000000000000000000000000000000200002c00000000010082040800070578041c00000020000180070000000000000000000000000000000000000000005b57bb',
)

/*
 * Two real, consecutive 114-byte status frames from the 이불 cycle used to confirm the ENERGY
 * byte (2026-09-13) - buf[81] reads 0 then 1, a plain +1 Wh step. See RD20_S.ts's file header for
 * how the byte's scale itself was confirmed (this pair only exercises the delta plumbing).
 */
const ENERGY_0WH = buf(
    'aaff300a007600d72a000100ec0064000000000000000000000000000100000000000000000000000000800700000000000000000000000000000000000000000000000200000400000000af00af07010002000000040000000000418007000000000000000000000000000000000000000000e155bb',
)
const ENERGY_1WH = buf(
    'aaff300a007600d749000100ec006400000200000400000000af00af0701000200000004000000000041800700000000000000000000000000000000000000000000000200000400000000ae00af070100020001000400000000004180070000000000000000000000000000000000000000005e59bb',
)

// Real notification-channel frames - see the file header's NOTIFICATION section. Confirmed on 4
// independent real completions (2026-09-09, 09-11, and twice on 09-13), each ~1.1-1.6s before the
// official integration's event.geonjogi_notification fired drying_is_complete.
const NOTIFICATION_CODE_00 = buf('aa09307200000000bb')
// See the file header's NOTIFICATION CORRECTION section - these two are remote_control, not part
// of the drying_is_complete signal (a live toggle test the same day disproved the original lumped
// reading of 0xc8). Confirmed by a clean on/off/on/off round trip (4 samples).
const NOTIFICATION_REMOTE_ON = buf('aa09307200c9004bbb')
const NOTIFICATION_REMOTE_OFF = buf('aa09307200c80048bb')

// Real course-id frames - see the file header's COURSE section. Captured 2026-09-22 across a real
// AI Course cycle: NORMAL while the panel/app was still being browsed, then AI_COURSE from
// selection through to completion ~103 minutes later.
const COURSE_NORMAL = buf('aa07307f0336bb')
const COURSE_AI = buf('aa07307f0431bb')

/*
 * Real 114-byte status frames, mined from the live one-control-at-a-time idle testing that found
 * the fields below (2026-09-14) - see RD20_S.ts's file header for the full account, including the
 * scratch-tooling offset bug that had to be found and corrected first. Each pair is consecutive
 * real captures spanning exactly one control's on/off (or armed/cancelled) transition, nothing
 * else changing between them.
 */
const DRUM_LIGHT_OFF = buf(
    'aaff300a00760044c2000100ec00640003020000070000000064001e010000000000000700000020000480070000000000000000000000000000000000000000000003020000070000000064001e010000000000000700000000000480070000000000000000000000000000000000000000008958bb',
)
const DRUM_LIGHT_ON = buf(
    'aaff300a00760044d3000100ec00640003020000070000000064001e010000000000000700000000000480070000000000000000000000000000000000000000000003020000070000000064001e010000000000000700000020000480070000000000000000000000000000000000000000009578bb',
)
const IRONING_ALERT_ON = buf(
    'aaff300a007600458b000100ec00640003020000070000000064001e010000000000000700000000000480070000000000000000000000000000000000000000000003020000070000000064001e010000000000040700000040000480070000000000000000000000000000000000000000005326bb',
)
const IRONING_ALERT_OFF = buf(
    'aaff300a0076004599000100ec00640003020000070000000064001e010000000000040700000040000480070000000000000000000000000000000000000000000003020000070000000064001e01000000000004070000000000048007000000000000000000000000000000000000000000bfe3bb',
)
const ANTI_WRINKLE_ON = buf(
    'aaff300a00760045d3000100ec00640003020000070004740064001e010000000000000700000000000c80070000000000000000000000000000000000000000000003020000070004740064001e010000000000000700000008000c80070000000000000000000000000000000000000000008416bb',
)
const ANTI_WRINKLE_OFF = buf(
    'aaff300a00760045d8000100ec00640003020000070004740064001e010000000000000700000008000c80070000000000000000000000000000000000000000000003020000070004740064001e010000000000000700000000000c80070000000000000000000000000000000000000000008dcabb',
)
const BUTTON_LOCK_ON = buf(
    'aaff300a00760044f1000100ec00640003020000070000000064001e010000000000000700000020000480070000000000000000000000000000000000000000000003020000070000000064001e010000000000000700000020001480070000000000000000000000000000000000000000007444bb',
)
const BUTTON_LOCK_OFF = buf(
    'aaff300a0076004501000100ec00640003020000070000000064001e010000000000000700000020001480070000000000000000000000000000000000000000000003020000070000000064001e01000000000000070000002000048007000000000000000000000000000000000000000000d5debb',
)
// 3-hour reservation just armed - buf[70..71] = 00 b4 (180 min).
const RESERVATION_3H = buf(
    'aaff300a00760045be000100ec00640003020000070000000064001e010000000000040700000000000480070000000000000000000000000000000000000000000003020000070000b40064001e010000000000040700000000000c80070000000000000000000000000000000000000000005081bb',
)
// Cancelled - buf[70..71] back to 00 00.
const RESERVATION_OFF = buf(
    'aaff300a00760045e0000100ec00640003020000070004740064001e010000000000000700000000000c80070000000000000000000000000000000000000000000003020000070000000064001e010000000000000700000000000480070000000000000000000000000000000000000000008a08bb',
)
// buf[89] reads 0x04 here (idle, not one of the three running-family values), buf[82]=2 - the
// alarm volume was set to 보통 (medium) just before this was captured, predicted then confirmed.
const ALARM_VOLUME_MEDIUM = buf(
    'aaff300a0076004510000100ec00640003020000070000000064001e010000000000010700000020000480070000000000000000000000000000000000000000000003020000070000000064001e010000000000020700000020000480070000000000000000000000000000000000000000008a31bb',
)

function makeDevice(id = DEVICE_ID) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(id, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev, id }
}

describe(MODEL_ID, () => {
    test('declares power and remain_time_minutes', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components), [
            'power',
            'remain_time_minutes',
            'remaining_minutes',
            'state',
            'status',
            'course',
            'energy',
            'energy_hour',
            'energy_day',
            'energy_month',
            // energy_total/alarm_volume/anti_wrinkle/button_lock: withdrawal stubs (platform-only,
            // see the config itself) - energy_total was removed once hour/day/month covered the
            // need, the other three are the pre-rename names for buzzer/wrinkle_care/child_lock
            // below (see the RENAMED note in RD20_S.ts's own header), all withdrawn 2026-09-18.
            'energy_total',
            'alarm_volume',
            'anti_wrinkle',
            'button_lock',
            'notification',
            'remote_control',
            'drum_light',
            'drumlight_auto_on',
            'drum_light_auto',
            'wrinkle_care',
            'ironing_alert',
            'child_lock',
            'reserve_time_minutes',
            'reservation_minutes',
            'buzzer',
        ])
        assert.equal(components.power.command_topic, '$this/power/set')
        assert.equal(components.drumlight_auto_on.command_topic, '$this/drumlight_auto_on/set')
        assert.equal(components.remain_time_minutes.platform, 'sensor')
        assert.equal(components.remain_time_minutes.unit_of_measurement, 'min')
        // The 2026-09-22 renames withdraw their four old names as removal stubs, same mechanism
        // as energy_total/alarm_volume/anti_wrinkle/button_lock above.
        for (const old of ['remaining_minutes', 'status', 'drum_light_auto', 'reservation_minutes']) {
            assert.deepEqual(Object.keys(components[old]), ['platform'], old)
        }
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

    test('drum_light_auto write reproduces the captured frame byte for byte (ON only - see file header)', () => {
        // Only the "on" direction was actually captured against a real unit - see RD20_S.ts's
        // DRUM LIGHT AUTO-ON section. Not paired with an "OFF" case the way the power test above
        // is, since that value has not been independently confirmed, just assumed symmetric.
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('drumlight_auto_on', 'ON')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa0df0e5000201ff011b01febb')
    })

    test('drum_light_auto is published optimistically as soon as it is set, not waiting on a device echo', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('drumlight_auto_on', 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.drumlight_auto_on, 'ON')
        dev.setProperty('drumlight_auto_on', 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.drumlight_auto_on, 'OFF')
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

    test('remaining_minutes starts at 0 on construction, not whatever MQTT retained from before a restart', () => {
        const { ha } = makeDevice()
        assert.equal(ha.devices[DEVICE_ID].properties.remain_time_minutes, 0)
    })

    test('remaining_minutes zeroes on power-off, since the status frame carrying it never arrives to do it itself', () => {
        const { thinq, dev, ha } = makeDevice()
        dev.setProperty('power', 'ON')
        thinq.emit('data', STATE_99_MIN_LEFT)
        assert.equal(ha.devices[DEVICE_ID].properties.remain_time_minutes, 99)
        dev.setProperty('power', 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.remain_time_minutes, 0)
    })

    test('the 114-byte status frame publishes remaining_minutes, matching the official integration', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_99_MIN_LEFT)
        assert.equal(ha.devices[DEVICE_ID].properties.remain_time_minutes, 99)
        thinq.emit('data', STATE_74_MIN_LEFT)
        assert.equal(ha.devices[DEVICE_ID].properties.remain_time_minutes, 74)
        thinq.emit('data', STATE_58_TO_11_MIN_LEFT)
        assert.equal(
            ha.devices[DEVICE_ID].properties.remain_time_minutes,
            11,
            'reads the second (current) record, not the first',
        )
    })

    test('the status byte publishes running/cooling/complete, matching two independent real cycles', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_RUNNING_18_MIN_LEFT)
        assert.equal(ha.devices[DEVICE_ID].properties.state, 'running')
        thinq.emit('data', STATUS_COOLING_5_MIN_LEFT)
        assert.equal(ha.devices[DEVICE_ID].properties.state, 'cooling')
        thinq.emit('data', STATUS_COMPLETE_1_MIN_LEFT)
        assert.equal(ha.devices[DEVICE_ID].properties.state, 'complete')
    })

    test('status 0x00 publishes power_off, confirmed live against the cloud snapshot API', () => {
        const { ha, thinq } = makeDevice()
        // Same shape as STATUS_RUNNING_18_MIN_LEFT with the status byte (buf[89]) forced to 0 -
        // see the STATUS_NAMES entry's own comment for how this was confirmed (cloud snapshot's
        // washerDryer.state read POWEROFF at the exact moment this handler's own status read
        // unknown_0, with the power switch also off).
        const frame = Buffer.from(STATUS_RUNNING_18_MIN_LEFT)
        frame[2 + 89] = 0x00
        thinq.emit('data', frame)
        assert.equal(ha.devices[DEVICE_ID].properties.state, 'power_off')
    })

    test('an unrecognised status value publishes as unknown_<value> rather than being guessed', () => {
        const { ha, thinq } = makeDevice()
        // Same shape as STATUS_RUNNING_18_MIN_LEFT with the status byte (buf[89]) forced to a
        // value never confirmed live.
        const frame = Buffer.from(STATUS_RUNNING_18_MIN_LEFT)
        frame[2 + 89] = 0x99
        thinq.emit('data', frame)
        assert.equal(ha.devices[DEVICE_ID].properties.state, 'unknown_153')
    })

    test('a real +1Wh step between two consecutive status frames publishes an energy delta', async () => {
        freshEnergyDir()
        // A device id distinct from DEVICE_ID: other tests in this file emit real status frames
        // too (for remaining_minutes/status), each with their own incidental buf[81] byte, and
        // their own fire-and-forget recordEnergyDelta call can still land after this test starts
        // - a shared id would let a stray delta from one of those bleed into this test's total.
        const { ha, thinq } = makeDevice('energy-test-1')
        // First frame only establishes lastEnergyRaw (0) - nothing to diff against yet, so no
        // recordDelta call happens here. energy_hour already reads 0 regardless, from
        // energyAccumulator.attach()'s own immediate baseline publish at construction (see
        // energy-accumulator.ts's scheduleHourlyRefresh) - this is not this frame's doing.
        thinq.emit('data', ENERGY_0WH)
        await settle()
        assert.equal(ha.devices['energy-test-1'].properties.energy_hour, 0)
        // The raw byte itself (0) seeds cycleEnergyWh on this first frame - see the file header's
        // ENERGY section and cycleEnergyWh's own comment.
        assert.equal(ha.devices['energy-test-1'].properties.energy, 0)
        // The second frame's buf[81] reads 1 - a plausible +1 Wh step - so this one publishes.
        thinq.emit('data', ENERGY_1WH)
        await settle()
        assert.equal(ha.devices['energy-test-1'].properties.energy_hour, 1)
        assert.equal(ha.devices['energy-test-1'].properties.energy, 1, 'this-cycle total tracks the same step')
    })

    test('a large jump in the energy byte (cycle-boundary reset) is discarded, not counted', async () => {
        freshEnergyDir()
        const { ha, thinq } = makeDevice('energy-test-2')
        thinq.emit('data', ENERGY_0WH)
        await settle()
        // Same shape as ENERGY_1WH, but with the energy byte forced far past the plausible
        // per-step ceiling - simulating a fresh cycle's counter having reset (see the file
        // header's ENERGY section for why this must not be read as a real 200Wh step).
        const frame = Buffer.from(ENERGY_1WH)
        frame[2 + 81] = 200
        thinq.emit('data', frame)
        await settle()
        // Stays at energyAccumulator.attach()'s construction-time baseline (see the sibling test
        // above) rather than jumping to 200 - proving the implausible delta was discarded, not
        // that nothing was ever published.
        assert.equal(ha.devices['energy-test-2'].properties.energy_hour, 0)
        // But the this-cycle total DOES follow it - a jump this large means a new cycle started,
        // not that 200 Wh landed in one report, so cycleEnergyWh restarts from the raw byte's own
        // (now-reset) value rather than being discarded like the calendar-bucket delta was.
        assert.equal(ha.devices['energy-test-2'].properties.energy, 200)
    })

    test('notification code 0 publishes drying_is_complete', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', NOTIFICATION_CODE_00)
        assert.equal(JSON.parse(String(ha.devices[DEVICE_ID].properties.notification)).event_type, 'drying_is_complete')
    })

    // See the file header's NOTIFICATION CORRECTION section - 0xc8/0xc9 are remote_control, not
    // drying_is_complete.
    test('notification codes 0xc9/0xc8 publish remote_control, not drying_is_complete', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', NOTIFICATION_REMOTE_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_control, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.notification, undefined)
        thinq.emit('data', NOTIFICATION_REMOTE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.remote_control, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.notification, undefined)
    })

    test('course id reads sub=0x30/opcode=0x7f byte[2], confirmed against a real AI Course cycle', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COURSE_NORMAL)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'normal')
        thinq.emit('data', COURSE_AI)
        assert.equal(ha.devices[DEVICE_ID].properties.course, 'ai_course')
    })

    test('an unnamed course id publishes as #<id> rather than being guessed at', () => {
        const { ha, thinq } = makeDevice()
        // Synthetic, not a real capture - COURSE_NORMAL/COURSE_AI's own checksum formula (see
        // AABBDevice.send()) applied to an id neither of them used, just to exercise the fallback.
        thinq.emit('data', buf('aa07307f0530bb'))
        assert.equal(ha.devices[DEVICE_ID].properties.course, '#5')
    })

    test('drum_light reads buf[87] 0x20, confirmed by a real on/off reversal', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', DRUM_LIGHT_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.drum_light, 'OFF')
        thinq.emit('data', DRUM_LIGHT_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.drum_light, 'ON')
    })

    test('ironing_alert reads buf[87] 0x40, confirmed by a real on/off reversal', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', IRONING_ALERT_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.ironing_alert, 'ON')
        thinq.emit('data', IRONING_ALERT_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.ironing_alert, 'OFF')
    })

    test('wrinkle_care reads buf[87] 0x08, confirmed by a real on/off reversal', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ANTI_WRINKLE_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.wrinkle_care, 'ON')
        thinq.emit('data', ANTI_WRINKLE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.wrinkle_care, 'OFF')
    })

    test('child_lock reads buf[89] (STATUS_OFFSET) bit 0x10, confirmed by a real on/off reversal', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', BUTTON_LOCK_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'ON')
        thinq.emit('data', BUTTON_LOCK_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.child_lock, 'OFF')
    })

    test('reservation_minutes reads buf[70..71] as 16-bit minutes, confirmed by a real arm/cancel', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', RESERVATION_3H)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time_minutes, 180)
        thinq.emit('data', RESERVATION_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.reserve_time_minutes, 0)
    })

    test('buzzer reads buf[82] while idle, matching the on-screen 보통(medium) setting', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ALARM_VOLUME_MEDIUM)
        assert.equal(ha.devices[DEVICE_ID].properties.buzzer, 'medium')
    })

    test('buzzer is not published while a real cycle is running (STATUS is running/cooling/complete)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_RUNNING_18_MIN_LEFT)
        assert.equal(ha.devices[DEVICE_ID].properties.buzzer, undefined)
    })
})
