import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DUT from '@/cloud/devices/3REK2G03VI200S_2'
import type { Metadata } from '@/cloud/thinq'
import { configure as configureEnergyAccumulator } from '@/cloud/energy-accumulator'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = '3REK2G03VI200S_2'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

/** energy-accumulator.ts persists to disk and caches by device id - point it at a fresh scratch
 *  dir (which also clears its cache) so this test starts from nothing, the same way
 *  RD20_S.test.ts/2REF21EBNSX_3.test.ts isolate themselves, and so it never touches the real
 *  /share/rethink/energy path. */
function freshEnergyDir() {
    const dir = mkdtempSync(join(tmpdir(), '3rek2g03vi200s2-energy-test-'))
    configureEnergyAccumulator(dir)
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
}

/** recordDelta() is fire-and-forget (`void ...`) from processAABB, so its file I/O has not
 *  necessarily landed yet the instant `thinq.emit` returns - give it a beat. */
async function settle() {
    await new Promise((r) => setTimeout(r, 50))
}

/*
 * Fixtures. All REAL frames, captured 2026-09-10 by driving my.lgthinq.com directly (Playwright)
 * against a real unit and reading rethink's on-box capture log for the same timestamps - see
 * 3REK2G03VI200S_2.ts's file header.
 */
const ACK = buf('aa071100e5f2bb')
// The identification block - two ASCII serial/part-number strings, not live state.
const ID_BLOCK = buf(
    'aa371131020153414134323237363330310000388a000040000003c00002534141343234343534303100005330000040000003c0001bbb',
)
// Baseline query response: 상칸=냉동(06), 중칸=맛지킴김치중(00), 하칸=맛지킴김치중(00), 원터치탈취=off, doors closed.
const QUERY_RESPONSE_BASELINE = buf('aa1011eb0206ff0000ff00010001ebbb')

// Real per-compartment door events - see the file header's record[7]/record[8] notes.
const TOP_DOOR_OPEN = buf('aa1a11ec0206ff0000ff000100010206ff0000ff0000010184bb')
const TOP_DOOR_CLOSE = buf('aa1a11ec0206ff0000ff000001010206ff0000ff0001000184bb')
// A middle-compartment door open: only the aggregate (index 8) moves, index 7 (상칸-specific) does not.
const MIDDLE_DOOR_OPEN = buf('aa1a11ec0206ff0000ff000100010206ff0000ff0001010187bb')

// 상칸 냉동(06) -> 유산균 김치+(0a), a real state push (no write captured - this one was set from
// the appliance's own physical panel, not remotely).
const STATE_TOP_TO_PROBIOTIC = buf('aa1a11ec0206ff0000ff00000101020aff0000ff0000010180bb')

// 중칸 맛지킴김치중(00) -> 맛지킴김치강(01), driven remotely via my.lgthinq.com.
const WRITE_MIDDLE_TO_STRONG = buf('aa0ff0e5000201ff0100030001c0bb')
const ECHO_MIDDLE_TO_STRONG = buf('aa1811e6000201ff010003000206ff0000ff0001000192bb')
const STATE_MIDDLE_TO_STRONG = buf('aa1a11ec0206ff0000ff000100010206ff0100ff0001000187bb')

// 하칸 맛지킴김치중(00) -> 육류/생선(07), driven remotely.
const WRITE_BOTTOM_TO_MEAT_FISH = buf('aa0ff0e5000201ff0100040007c9bb')
const STATE_BOTTOM_TO_MEAT_FISH = buf('aa1a11ec0206ff0100ff000100010206ff0107ff000100018fbb')

// 원터치 탈취 off(00) -> on(01), driven remotely.
const WRITE_ONE_TOUCH_ON = buf('aa0ff0e5000201ff0100060001cdbb')
const STATE_ONE_TOUCH_ON = buf('aa1a11ec0206ff0000ff000100010206ff0000ff0101000187bb')

// 상칸 switched to 꺼짐(09) from the panel (2026-09-15) - both halves of the dual record already
// agree 09, so this is the settled state after the switch, not a frame caught mid-transition.
const STATE_TOP_OFF = buf('aa1a11ec0209ff0000ff010001010209ff0000ff0001000182bb')
// 중칸/하칸 both switched to 꺼짐 in the same sitting - middle to 0x0d, bottom to 0x09. Also
// caught here: turning 중/하칸 off flips 상칸 back from its own 꺼짐(09) to 냉동(06) as a real
// appliance side effect (confirmed by the owner asking, not assumed) - see RECORD_TOP_MODE_NAMES'
// own comment. This fixture is the state AFTER that settled, not the moment it happened.
const STATE_MIDDLE_BOTTOM_OFF = buf('aa1a11ec0206ff0d09ff000001010206ff0d09ff00010001a8bb')

// 중칸 야채·과일 - the two of its three levels the original 2026-09-10 sweep never triggered
// (강 was caught separately, see the header), pressed live 2026-09-15 while cycling through the
// whole submenu from the panel.
const STATE_MIDDLE_VEGI_MEDIUM = buf('aa1a11ec0203ff0106ff000001010203ff0306ff000001018ebb') // -> 야채·과일 (중)
const STATE_MIDDLE_VEGI_WEAK = buf('aa1a11ec0203ff0406ff000001010203ff0506ff00000101b5bb') // -> 야채·과일 (약)

// Two consecutive real `11 3e` energy reports, mined from the frame log (2026-09-10) - see the
// file header's ENERGY COUNTER section. total 246 + delta 16 -> total 262, the additive
// relationship confirmed across all 130 real samples mined, not just these two.
const ENERGY_REPORT_TOTAL_246 = buf('aa0b113e001000f60e4dbb')
const ENERGY_REPORT_DELTA_16_TOTAL_262 = buf('aa0b113e001001060f7fbb')

// Real 15-byte notification-channel frame, the one sample caught so far - see the file header's
// NOTIFICATION section. payload[1] (buf[3]) = 23 = 'door_is_open', this model's only possible
// notification type per the official integration's own declared event_types.
const NOTIFICATION_DOOR_IS_OPEN = buf('aa13117200170a0000000000000000000034bb')

function makeDevice(id = DEVICE_ID) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(id, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('component names are plain ASCII, with no Korean text for HA to mangle when it derives entity_id', () => {
        // Regression test for the real 2026-09-10 bug: this device's component names used to carry
        // a Korean compartment hint ("Bottom compartment (하칸)"), and HA's own entity_id slugifier
        // phonetically transliterated it into "..._hakan" - not something this codebase chose or
        // can reliably override (see homeassistant.ts's publishConfig() for what was tried and
        // reverted). The durable fix is simply not putting non-ASCII text in `name` in the first
        // place; HA's own default slugify handles plain ASCII exactly as expected already, the same
        // way it always has for every other device in this fork.
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        for (const [key, comp] of Object.entries(components)) {
            assert.equal(
                /^[\x20-\x7e]*$/.test(comp.name as string),
                true,
                `${key}'s name ("${comp.name}") is not plain ASCII`,
            )
        }
    })

    test('declares the three per-compartment selects, one-touch deodorize switch, and two door sensors', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components).sort(), [
            // Withdrawal stub for the pre-2026-09-23 name - see the component's own comment.
            'any_door_open',
            'at_least_one_door_open',
            'bottom_compartment',
            'energy_day',
            'energy_hour',
            'energy_month',
            // energy_total/energy_total_counter: withdrawal stubs (platform-only, see the config
            // itself), not real entities - removed 2026-09-18 once energy_hour/day/month covered
            // the need.
            'energy_total',
            'energy_total_counter',
            'middle_compartment',
            'notification',
            'one_touch_deodorize',
            'top_compartment',
            'top_door_open',
        ])
        assert.deepEqual(components.top_compartment.options, [
            '맛지킴 김치 (중)',
            '맛지킴 김치 (강)',
            '맛지킴 김치 (약)',
            '냉장 (중)',
            '냉장 (강)',
            '냉장 (약)',
            '냉동',
            '익힘',
            '꺼짐',
            '유산균 김치+',
        ])
        // 야채·과일 (중/강/약) and, on 하칸 only, 쌀·잡곡 were first added from this exact model's
        // own official modelJSON schema (room3Temp_C/room4Temp_C); confirmed live 2026-09-15 -
        // see the file header.
        assert.deepEqual(components.middle_compartment.options, [
            '맛지킴 김치 (중)',
            '맛지킴 김치 (강)',
            '맛지킴 김치 (약)',
            '야채·과일 (중)',
            '야채·과일 (강)',
            '야채·과일 (약)',
            '구입 김치',
            '유산균 김치+',
            '익힘',
            '꺼짐',
        ])
        assert.deepEqual(components.bottom_compartment.options, [
            '맛지킴 김치 (중)',
            '맛지킴 김치 (강)',
            '맛지킴 김치 (약)',
            '야채·과일 (중)',
            '야채·과일 (강)',
            '야채·과일 (약)',
            '쌀·잡곡',
            '육류/생선',
            '오래 보관',
            '꺼짐',
        ])
    })

    test('the query response publishes the real baseline reading', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', QUERY_RESPONSE_BASELINE)
        assert.equal(ha.devices[DEVICE_ID].properties.top_compartment, '냉동')
        assert.equal(ha.devices[DEVICE_ID].properties.middle_compartment, '맛지킴 김치 (중)')
        assert.equal(ha.devices[DEVICE_ID].properties.bottom_compartment, '맛지킴 김치 (중)')
        assert.equal(ha.devices[DEVICE_ID].properties.one_touch_deodorize, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.top_door_open, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.at_least_one_door_open, 'OFF')
    })

    test("start() sends the query frame once, byte for byte, and never again - see the file header's note on QUERY_FRAME", (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.start()
        assert.equal(thinq.outbox.length, 1, 'queried once on start')
        assert.equal(thinq.outbox[0].toString('hex'), 'aa0ef0ed1211010000010400ebbb')

        // No periodic re-query any more - STATE_TOP_TO_PROBIOTIC below is the proof a real state
        // change (physical panel included) reaches this handler reactively regardless.
        tickMockTimers(t, 60 * 60 * 1000)
        assert.equal(thinq.outbox.length, 1, 'no further query fired, even an hour later')

        dev.drop()
    })

    test('the ack frame is accepted and publishes nothing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ACK)
        assert.equal(ha.devices[DEVICE_ID].properties.top_compartment, undefined)
    })

    test('the identification block is recognised by shape and silently dropped', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', ID_BLOCK)
        assert.equal(
            ha.devices[DEVICE_ID].properties.top_compartment,
            undefined,
            'not parsed, just recognised and ignored',
        )
        // @ts-expect-error seenUnknown is private - only reached by the generic unmodelled-frame
        // fallthrough, so its absence here proves the dedicated `11 31` branch caught it first.
        assert.equal(dev.seenUnknown.has('51:11:31'), false)
    })

    test('상칸 (top) door open/close moves both its own flag and the aggregate; 중칸 (middle) only moves the aggregate', () => {
        const { ha, thinq } = makeDevice()

        thinq.emit('data', TOP_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.top_door_open, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.at_least_one_door_open, 'ON')

        thinq.emit('data', TOP_DOOR_CLOSE)
        assert.equal(ha.devices[DEVICE_ID].properties.top_door_open, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.at_least_one_door_open, 'OFF')

        thinq.emit('data', MIDDLE_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.top_door_open, 'OFF', '중칸 has no bit of its own - unaffected')
        assert.equal(ha.devices[DEVICE_ID].properties.at_least_one_door_open, 'ON')
    })

    test("a real state push reflects a mode changed from the appliance's own physical panel (상칸 냉동 -> 유산균 김치+)", () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_TOP_TO_PROBIOTIC)
        assert.equal(ha.devices[DEVICE_ID].properties.top_compartment, '유산균 김치+')
    })

    test('상칸 꺼짐 - a raw value with no name in the original sweep, confirmed live 2026-09-15', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_TOP_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.top_compartment, '꺼짐')
    })

    test('중칸/하칸 꺼짐 together - each compartment keeps its own off code (0x0d vs 0x09)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_MIDDLE_BOTTOM_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.middle_compartment, '꺼짐')
        assert.equal(ha.devices[DEVICE_ID].properties.bottom_compartment, '꺼짐')
        // The interlock side effect (상칸 forced back to 냉동) is real appliance behaviour, not
        // something this handler enforces - this fixture is captured after it already happened,
        // so 상칸 reads 냉동 here simply because that is what the frame says, not because turning
        // 중/하칸 off is coded to also touch 상칸.
        assert.equal(ha.devices[DEVICE_ID].properties.top_compartment, '냉동')
    })

    test('중칸 야채·과일 (중)/(약) - the two levels the original sweep missed, confirmed live 2026-09-15', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_MIDDLE_VEGI_MEDIUM)
        assert.equal(ha.devices[DEVICE_ID].properties.middle_compartment, '야채·과일 (중)')
        thinq.emit('data', STATE_MIDDLE_VEGI_WEAK)
        assert.equal(ha.devices[DEVICE_ID].properties.middle_compartment, '야채·과일 (약)')
    })

    test('중칸 write reproduces the real frame byte for byte, published optimistically, then confirmed by the real state push', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('middle_compartment', '맛지킴 김치 (강)')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), WRITE_MIDDLE_TO_STRONG.toString('hex'))
        assert.equal(
            ha.devices[DEVICE_ID].properties.middle_compartment,
            '맛지킴 김치 (강)',
            'published optimistically',
        )

        thinq.emit('data', STATE_MIDDLE_TO_STRONG)
        assert.equal(
            ha.devices[DEVICE_ID].properties.middle_compartment,
            '맛지킴 김치 (강)',
            'confirmed by the real state push',
        )
    })

    test('하칸 write reproduces the real frame byte for byte', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('bottom_compartment', '육류/생선')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), WRITE_BOTTOM_TO_MEAT_FISH.toString('hex'))

        thinq.emit('data', STATE_BOTTOM_TO_MEAT_FISH)
        assert.equal(ha.devices[DEVICE_ID].properties.bottom_compartment, '육류/생선')
    })

    test('원터치 탈취 write reproduces the real frame byte for byte, and the resulting state is applied', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('one_touch_deodorize', 'ON')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), WRITE_ONE_TOUCH_ON.toString('hex'))
        assert.equal(ha.devices[DEVICE_ID].properties.one_touch_deodorize, 'ON', 'published optimistically')

        thinq.emit('data', STATE_ONE_TOUCH_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.one_touch_deodorize, 'ON', 'confirmed by the real state push')
    })

    test('the write echo (e6) is recognised by shape and silently dropped - its trailing bytes look like a record but are not a live one', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', ECHO_MIDDLE_TO_STRONG)
        assert.equal(ha.devices[DEVICE_ID].properties.middle_compartment, undefined, 'not applied as state')
        // @ts-expect-error seenUnknown is private - only reached by the generic unmodelled-frame
        // fallthrough, so its absence here proves the dedicated `e6` branch caught it first.
        assert.equal(dev.seenUnknown.has('20:11:e6'), false)
    })

    test('an unknown mode label logs a warning and sends nothing', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('top_compartment', '존재하지 않는 모드')
        assert.equal(thinq.outbox.length, 0)
    })

    test("the energy report's own delta feeds the calendar-boundary buckets - real samples from the additive 246->262 pair", async () => {
        freshEnergyDir()
        // A device id distinct from DEVICE_ID: other tests in this file emit real frames too,
        // each with their own fire-and-forget recordDelta call that could still land after this
        // test starts - a shared id would let a stray delta bleed in, same reasoning as
        // RD20_S.test.ts/2REF21EBNSX_3.test.ts's own energy tests.
        const { ha, thinq } = makeDevice('energy-test-1')
        // <delta>=16 in both real captures (each report's delta is read straight off the wire,
        // not diffed against a stored previous value like the fridge/kimchi-fridge's own raw
        // counter is), so each frame adds its own 16 - the running total 246->262 they also carry
        // is confirmed additive in the file header's ENERGY COUNTER section, but not read here
        // anymore.
        thinq.emit('data', ENERGY_REPORT_TOTAL_246)
        await settle()
        assert.equal(ha.devices['energy-test-1'].properties.energy_hour, 16)
        thinq.emit('data', ENERGY_REPORT_DELTA_16_TOTAL_262)
        await settle()
        assert.equal(ha.devices['energy-test-1'].properties.energy_hour, 32, '16 + 16')
    })

    test('a real notification-channel frame publishes door_is_open', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', NOTIFICATION_DOOR_IS_OPEN)
        assert.equal(JSON.parse(String(ha.devices[DEVICE_ID].properties.notification)).event_type, 'door_is_open')
    })
})
