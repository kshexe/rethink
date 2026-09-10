import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/3REK2G03VI200S_2'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = '3REK2G03VI200S_2'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

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

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
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
            'any_door_open',
            'bottom_compartment',
            'middle_compartment',
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
            '유산균 김치+',
        ])
        // 야채·과일 (중/강/약) and, on 하칸 only, 쌀·잡곡 come from this exact model's own official
        // modelJSON schema (room3Temp_C/room4Temp_C), not a live capture - see the file header.
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
        assert.equal(ha.devices[DEVICE_ID].properties.any_door_open, 'OFF')
    })

    test('start() sends the query frame immediately, byte for byte, and again on a timer', (t) => {
        enableMockTimers(t)
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.start()
        assert.equal(thinq.outbox.length, 1, 'queried once on start')
        assert.equal(thinq.outbox[0].toString('hex'), 'aa0ef0ed1211010000010400ebbb')

        tickMockTimers(t, 5 * 60 * 1000)
        assert.equal(thinq.outbox.length, 2, 'queried again after the interval')
        assert.equal(thinq.outbox[1].toString('hex'), thinq.outbox[0].toString('hex'))

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
        assert.equal(ha.devices[DEVICE_ID].properties.any_door_open, 'ON')

        thinq.emit('data', TOP_DOOR_CLOSE)
        assert.equal(ha.devices[DEVICE_ID].properties.top_door_open, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.any_door_open, 'OFF')

        thinq.emit('data', MIDDLE_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.top_door_open, 'OFF', '중칸 has no bit of its own - unaffected')
        assert.equal(ha.devices[DEVICE_ID].properties.any_door_open, 'ON')
    })

    test("a real state push reflects a mode changed from the appliance's own physical panel (상칸 냉동 -> 유산균 김치+)", () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_TOP_TO_PROBIOTIC)
        assert.equal(ha.devices[DEVICE_ID].properties.top_compartment, '유산균 김치+')
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
})
