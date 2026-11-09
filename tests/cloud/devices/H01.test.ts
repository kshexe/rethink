import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DUT from '@/cloud/devices/H01'
import type { Metadata } from '@/cloud/thinq'
import { configure as configureEnergyAccumulator, flush as flushEnergyAccumulator } from '@/cloud/energy-accumulator'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'H01'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

/** energy-accumulator.ts persists to disk and caches by device id - point it at a fresh scratch
 *  dir (which also clears its cache) so the energy test starts from nothing, the same way
 *  RD20_S.test.ts/MI2D7B.test.ts isolate themselves, and so this test never touches the real
 *  /share/rethink/energy path. */
function freshEnergyDir() {
    const dir = mkdtempSync(join(tmpdir(), 'h01-energy-test-'))
    configureEnergyAccumulator(dir)
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
}

/** recordDelta() is fire-and-forget (`void ...`) from processEnergyReport, so its file I/O has
 *  not necessarily landed the instant `thinq.emit` returns - see RD20_S.test.ts's identical
 *  helper for why this waits rather than guessing a fixed delay. */
async function settle() {
    await flushEnergyAccumulator()
}

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

/*
 * Real 0xEC status frames bracketing each of the six settings toggles, captured 2026-09-18
 * clicking each one in turn on the 설정 screen (appliance powered on first - see H01.ts's file
 * header SETTINGS BITFIELD WRITE section for why that is required) and reverting it afterward.
 * Each pair's OLD record is the state right before that one write, the NEW record is right after -
 * the isolation technique this fork uses throughout, one control at a time.
 */
const SETTINGS_END_MELODY_ON = buf(
    'aa3a32ec00180100000037050000370000500000000b935f00000000000c' +
        '00180100000037050000370000500000000b975f00000000000c85bb',
)
const SETTINGS_AIR_FILTER_OFF = buf(
    'aa3a32ec00180100000037050000370000500000000b935f00000000000c' +
        '00180100000037050000370000500000000b835f00000000000ce9bb',
)
const SETTINGS_WASH_COMPLETE_LIGHT_OFF = buf(
    'aa3a32ec00180100000037050000370000500000000b935f00000000000c' +
        '00180100000037050000370000100000000b935f00000000000cd9bb',
)
const SETTINGS_TIME_DISPLAY_OFF = buf(
    'aa3a32ec00180100000037050000370000500000000b935f00000000000c' +
        '001801000000370500003700005000000003935f00000000000c91bb',
)
const SETTINGS_AUTO_SELECT_OFF = buf(
    'aa3a32ec00180100000037050000370000500000000b935f00000000000c' +
        '00180100000037050000370000400000000b935f00000000000ce9bb',
)
const SETTINGS_COOL_DRY_OFF = buf(
    'aa3a32ec00180100000037050000370000500000000b935f00000000000c' +
        '00180100000037050000370000500000000b925f00000000000c9ebb',
)

function makeDevice(deviceId: string = DEVICE_ID) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(deviceId, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

/*
 * NOT A REAL CAPTURE - see H01.ts's file header ENERGY section. Constructed per upstream
 * H11.ts's documented `32 3e <delta:u16BE> <accum:u16BE> <report#>` shape (7-byte inner payload,
 * matching ENERGY_LEN) purely to exercise this fork's own parsing arithmetic - delta=50 (0x0032),
 * accum=500 (0x01f4), report#=3. This only tests that processEnergyReport reads the two u16
 * fields at the right offsets; it proves nothing about whether our actual H01 unit ever sends
 * this frame at all.
 */
const ENERGY_REPORT_SYNTHETIC = buf('aa0b323e003201f4031abb')

describe(MODEL_ID, () => {
    test('declares power and the six settings toggles as writable; the rest are read-only sensors', () => {
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
            'high_temp',
            // Withdrawal stub for the pre-2026-09-23 name - see the component's own comment.
            'high_temp_sterilize',
            'extra_rinse',
            'heat_dry',
            'hot_air_dry_minutes',
            'end_alarm_sound',
            'end_melody',
            'air_filter',
            'air_filter_reminder',
            'wash_complete_light',
            'time_indicator',
            'time_display',
            'auto_select',
            'cool_dry',
            // See the file header's ENERGY section - speculative, unverified against our own unit.
            'energy',
            'energy_hour',
            'energy_day',
            'energy_month',
            // See the file header's COURSE START section - speculative, unverified against our
            // own unit.
            'target_course',
            'start_course',
        ])
        const writable = [
            'power',
            'end_alarm_sound',
            'air_filter',
            'wash_complete_light',
            'time_indicator',
            'auto_select',
            'cool_dry',
            'target_course',
            'start_course',
        ]
        for (const key of writable) {
            assert.equal(components[key].command_topic, `$this/${key}/set`, `${key} has a command_topic`)
        }
        for (const key of Object.keys(components)) {
            if (writable.includes(key)) continue
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

    /*
     * NOT A REAL CAPTURE - see the file header's COURSE START section. `f0 26 10 <course> ...` has
     * never been seen on our own unit's wire; this only exercises this fork's own byte assembly
     * against the shape upstream H11.ts/N02.ts confirm for the same 0x32 family, using this file's
     * own already-confirmed course index for "표준" (5, see STATUS RECORD).
     */
    test('start_course is not sent before target_course is set', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 0)
    })

    test('target_course is published optimistically, start_course then reproduces the UNVERIFIED shape', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('target_course', '표준')
        assert.equal(ha.devices[DEVICE_ID].properties.target_course, '표준')
        thinq.resetRecorder()
        dev.setProperty('start_course', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), 'aa0df02610050000000000b7bb')
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
        assert.equal(props.high_temp, 'OFF')
        assert.equal(props.extra_rinse, 'OFF')
        assert.equal(props.heat_dry, 0)
        // See the file header's SETTINGS BITFIELD WRITE section - this fixture's baseline state.
        assert.equal(props.auto_select, 'ON')
        assert.equal(props.wash_complete_light, 'ON')
        assert.equal(props.time_indicator, 'ON')
        assert.equal(props.cool_dry, 'ON')
        assert.equal(props.end_alarm_sound, 'OFF')
        assert.equal(props.air_filter, 'ON')
    })

    test('a real 0xEB query response decodes the same way as an 0xEC record', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_EB_OFF_55MIN)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'OFF')
        assert.equal(props.duration_minutes, 55)
        assert.equal(props.course_index, 0)
    })

    describe('the six settings toggles', () => {
        // Each real capture below is the frame right after turning that one control off, with
        // every other control left at the STATUS_EC_STANDARD_55MIN baseline (auto_select/
        // wash_complete_light/time_indicator/cool_dry/air_filter all ON, end_alarm_sound OFF) -
        // see H01.ts's file header SETTINGS BITFIELD WRITE section.
        const cases: [string, ReturnType<typeof buf>, string][] = [
            ['end_alarm_sound', SETTINGS_END_MELODY_ON, 'ON'],
            ['air_filter', SETTINGS_AIR_FILTER_OFF, 'OFF'],
            ['wash_complete_light', SETTINGS_WASH_COMPLETE_LIGHT_OFF, 'OFF'],
            ['time_indicator', SETTINGS_TIME_DISPLAY_OFF, 'OFF'],
            ['auto_select', SETTINGS_AUTO_SELECT_OFF, 'OFF'],
            ['cool_dry', SETTINGS_COOL_DRY_OFF, 'OFF'],
        ]
        for (const [prop, frame, want] of cases) {
            test(`${prop} reads ${want} off a real captured status frame, siblings unaffected`, () => {
                const { ha, thinq } = makeDevice()
                thinq.emit('data', frame)
                assert.equal(ha.devices[DEVICE_ID].properties[prop], want)
            })
        }

        test('a settings write is not sent before any status record has been seen', () => {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty('auto_select', 'OFF')
            assert.equal(thinq.outbox.length, 0)
        })

        test('each settings write reproduces the captured frame byte for byte, both directions', () => {
            // All twelve reproduce real captures against the STATUS_EC_STANDARD_55MIN baseline
            // (byte4=0xb8/byte5=0x82) exactly, whichever one control changes for that write - see
            // H01.ts's file header.
            const writeCases: [string, string, string][] = [
                ['end_alarm_sound', 'ON', 'aa0ef0260000f882000000001dbb'],
                ['end_alarm_sound', 'OFF', 'aa0ef0260000b882000000005dbb'],
                ['air_filter', 'OFF', 'aa0ef0260000b8800000000053bb'],
                ['air_filter', 'ON', 'aa0ef0260000b882000000005dbb'],
                ['wash_complete_light', 'OFF', 'aa0ef0260000b0820000000055bb'],
                ['wash_complete_light', 'ON', 'aa0ef0260000b882000000005dbb'],
                ['time_indicator', 'OFF', 'aa0ef0260000a88200000000adbb'],
                ['time_indicator', 'ON', 'aa0ef0260000b882000000005dbb'],
                ['auto_select', 'OFF', 'aa0ef0260000988200000000bdbb'],
                ['auto_select', 'ON', 'aa0ef0260000b882000000005dbb'],
                ['cool_dry', 'OFF', 'aa0ef0260000388200000000ddbb'],
                ['cool_dry', 'ON', 'aa0ef0260000b882000000005dbb'],
            ]
            for (const [prop, value, want] of writeCases) {
                const { thinq, dev } = makeDevice()
                thinq.emit('data', STATUS_EC_STANDARD_55MIN)
                thinq.resetRecorder()
                dev.setProperty(prop, value)
                assert.equal(thinq.outbox.length, 1, `${prop}=${value} sent one frame`)
                assert.equal(thinq.outbox[0].toString('hex'), want, `${prop}=${value}`)
            }
        })

        test('a settings write is published optimistically as soon as it is set', () => {
            const { ha, thinq, dev } = makeDevice()
            thinq.emit('data', STATUS_EC_STANDARD_55MIN)
            dev.setProperty('cool_dry', 'OFF')
            assert.equal(ha.devices[DEVICE_ID].properties.cool_dry, 'OFF')
            dev.setProperty('cool_dry', 'ON')
            assert.equal(ha.devices[DEVICE_ID].properties.cool_dry, 'ON')
        })
    })

    // See the file header's ENERGY section and ENERGY_REPORT_SYNTHETIC's own comment above -
    // speculative, ported from upstream H11.ts, UNVERIFIED against our own unit. This only
    // proves the arithmetic; it is not evidence the real appliance sends this frame.
    describe('energy (speculative, unverified)', () => {
        test('a 32 3e report publishes the cycle total directly and feeds the hour/day/month accumulator', async () => {
            freshEnergyDir()
            const { ha, thinq } = makeDevice('energy-test-1')
            thinq.emit('data', ENERGY_REPORT_SYNTHETIC)
            await settle()
            assert.equal(ha.devices['energy-test-1'].properties.energy, 500, 'accum field published directly')
            assert.equal(ha.devices['energy-test-1'].properties.energy_hour, 50, 'delta field fed to the accumulator')
        })
    })
})
