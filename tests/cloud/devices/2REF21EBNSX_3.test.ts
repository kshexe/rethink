import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DUT from '@/cloud/devices/2REF21EBNSX_3'
import type { Metadata } from '@/cloud/thinq'
import { configure as configureEnergyAccumulator } from '@/cloud/energy-accumulator'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = '2REF21EBNSX_3'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

/** energy-accumulator.ts persists to disk and caches by device id - point it at a fresh scratch
 *  dir (which also clears its cache) so each energy test starts from nothing, the same way
 *  RD20_S.test.ts isolates itself, and so these tests never touch the real /share/rethink/energy
 *  path. */
function freshEnergyDir() {
    const dir = mkdtempSync(join(tmpdir(), '2ref21ebnsx3-energy-test-'))
    configureEnergyAccumulator(dir)
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
}

/** recordEnergyDelta() is fire-and-forget (`void ...`) from processAABB, so its file I/O has not
 *  necessarily landed yet the instant `thinq.emit` returns - give it a beat. */
async function settle() {
    await new Promise((r) => setTimeout(r, 50))
}

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
// Followed express_mode=ON: old record (fridge=4, freezer raw=4, express=1) then new (express=2).
const STATE_EXPRESS_ON = buf('aa2a10ec020404010700ff00010001ffffffffffff01020404020700ff00010001ffffffffffff01b8bb')
// The query frame this handler sends, and a real "eb" query response (fridge=4, freezer raw=4,
// express=1) captured mid-day, unrelated to any write of ours - see the file header.
const QUERY_FRAME_HEX = 'aa0ef0ed1211010000010400ebbb'
const QUERY_RESPONSE = buf('aa1810eb020404010700ff00010001ffffffffffff019ebb')
// The state frame that followed the Smart Care+ OFF write pair: old record (record[17]=1, on)
// then new record (record[17]=0, off) - record[4] also happens to move (7->2) in these same real
// captures, which is what first looked like the smart_care_v2 byte; see 2REF21EBNSX_3.ts's file
// header for why record[17] (matching upstream fridge_common.ts's documented 0/1 smartCare value)
// is the one this handler actually reads.
const STATE_SMART_CARE_OFF = buf('aa2a10ec020404010700ff00010001ffffffffffff01020404010200ff00010001ffffffffffff00b3bb')
// ...and back ON: old record (record[17]=0, off) then new record (record[17]=1, on).
const STATE_SMART_CARE_ON = buf('aa2a10ec020404010200ff00010001ffffffffffff00020404010700ff00010001ffffffffffff01b3bb')
// Hand-constructed, NOT a real capture (record[7]'s real captures - see below - happen to only
// ever show 0/1, not the documented quirk value 2) - built from STATE_FRIDGE_7's real shape with
// only record[7] changed, to check the decode logic itself honours the documented
// 0=closed/1=open/2=closed(!) convention rather than treating any nonzero byte as open. The
// checksum is irrelevant - this handler does not verify it.
const STATE_DOOR_OPEN_CONSTRUCTED = buf(
    'aa2a10ec020404010700ff00010001ffffffffffff01020704010700ff01010001ffffffffffff01a5bb',
)
const STATE_DOOR_QUIRK_2_IS_CLOSED_CONSTRUCTED = buf(
    'aa2a10ec020404010700ff00010001ffffffffffff01020704010700ff02010001ffffffffffff01a4bb',
)

// Real per-compartment door events, captured 2026-09-10 via 4 separate live, isolated open/close
// tests (one physical door at a time) - see the file header's DOOR OPEN BY COMPARTMENT section.
const FRIDGE_DOOR_OPEN = buf('aa0810a8010139bb')
const FRIDGE_DOOR_CLOSED = buf('aa0810a801003ebb')
const FREEZER_DOOR_OPEN = buf('aa0810a8020138bb')
const FREEZER_DOOR_CLOSED = buf('aa0810a8020039bb')

// Real captures of the energy-counter frame (see 2REF21EBNSX_3.ts's file header's ENERGY COUNTER
// section) - the first ever seen (2026-09-09T18:17:36Z, counter=7) and one from roughly a day later
// (2026-09-10T22:47:36Z, counter=87) - same shape, byte 2 differs (0x0f vs 0xfa) and is not read.
const ENERGY_COUNTER_7 = buf('aa0b10af0f00070404c7bb')
const ENERGY_COUNTER_87 = buf('aa0b10affa0057040498bb')

// Real capture (2026-09-10): the periodic ~5-minute full status dump, saved while checking for a
// food-poisoning-index field - see the file header's NOT YET DECODED note. Recognised by shape
// only, not parsed.
const PERIODIC_DUMP = buf(
    'aa0010cf00aa0121010101422631010405 0000ff510023dead0180ff820070deaddeaddeaddeadff25deaddeaddead013401905000003680ff1600000000a85e00a800020e000007d00000003a0000000000008010c38037000000000000000000000000000000000000000000000181000000037500291102e200d00462032c0043130e164600000000001586ff00000060200000000000000000000005001c000000000000000000000000000000b54b040101760101010144c0300a0b1901552d58fd8dfd27fd3e67fd8efd30fd5553518bfd20fd04c4fffdfffd1afd260504fdbefffdfd0700fd2b000000de445402001052160000740b0004203fbb'.replace(
        /\s/g,
        '',
    ),
)

function makeDevice(id = DEVICE_ID) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(id, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('declares the four writable components plus the read-only per-compartment door sensors', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components).sort(), [
            'energy_day',
            'energy_hour',
            'energy_month',
            'express_mode',
            'freezer_door_open',
            'freezer_temp',
            'fridge_door_open',
            'fridge_temp',
            'smart_care_v2',
        ])
        assert.equal(components.fridge_temp.min, 1)
        assert.equal(components.fridge_temp.max, 7)
        assert.equal(components.freezer_temp.min, -23)
        assert.equal(components.freezer_temp.max, -15)
        assert.equal(components.fridge_door_open.platform, 'binary_sensor')
        assert.equal(components.fridge_door_open.command_topic, undefined, 'read-only, no command topic')
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

    test('express_mode write reproduces the captured frame byte for byte', () => {
        for (const [value, want] of [
            ['ON', 'aa2ff017ffffff02ffffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffffeabb'],
            ['OFF', 'aa2ff017ffffff01ffffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffffebbb'],
        ] as [string, string][]) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty('express_mode', value)
            assert.equal(thinq.outbox.length, 1, `express_mode=${value} sent one frame`)
            assert.equal(thinq.outbox[0].toString('hex'), want, `express_mode=${value}`)
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

    test('all four are published optimistically as soon as they are set', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('fridge_temp', '5')
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_temp, 5)
        dev.setProperty('freezer_temp', '-20')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_temp, -20)
        dev.setProperty('express_mode', 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.express_mode, 'ON')
        dev.setProperty('smart_care_v2', 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_care_v2, 'OFF')
    })

    test('smart_care_v2 ON sends a single write; OFF sends the real two-frame sequence', () => {
        const { thinq, dev } = makeDevice()

        thinq.resetRecorder()
        dev.setProperty('smart_care_v2', 'ON')
        assert.equal(thinq.outbox.length, 1, 'ON is a single frame')
        assert.equal(
            thinq.outbox[0].toString('hex'),
            'aa2ff017ffffffffffffffffffffffffffffffffff01ffffff000000ffff00ffffffff00ffffffffffffffffffebbb',
        )

        thinq.resetRecorder()
        dev.setProperty('smart_care_v2', 'OFF')
        assert.equal(thinq.outbox.length, 2, 'OFF replays the real two-frame sequence')
        assert.equal(
            thinq.outbox[0].toString('hex'),
            'aa2ff017ffffffffffffffffffffffffffffffffff00ffffff000000ffff00ffffffff00ffffffffffffffffffe8bb',
        )
        assert.equal(
            thinq.outbox[1].toString('hex'),
            'aa2ff017ffffffff06ffffffffffffffffffffffffffffffff000000ffff00ffffffff00ffffffffffffffffff96bb',
        )
    })

    test('the state frame publishes the real smart_care_v2 reading, both directions', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_SMART_CARE_OFF)
        assert.equal(ha.devices[DEVICE_ID].properties.smart_care_v2, 'OFF', 'record[17] raw 0 -> off')
        thinq.emit('data', STATE_SMART_CARE_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.smart_care_v2, 'ON', 'record[17] raw 1 -> on')
    })

    test('the ack frame is accepted and publishes nothing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ACK)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_temp, undefined)
    })

    test('the periodic full status dump is recognised by shape and silently dropped - no unmodelled-frame noise', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', PERIODIC_DUMP)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_temp, undefined, 'not parsed, just recognised and ignored')
        // @ts-expect-error seenUnknown is private - only reached by the generic unmodelled-frame
        // fallthrough, so its absence here proves the dedicated `10 cf` branch caught it first.
        assert.equal(dev.seenUnknown.has('250:10:cf'), false)
    })

    test('the energy counter frame is recognised by shape (not gated on byte 2) and tracks the raw big-endian value internally', () => {
        const { thinq, dev } = makeDevice()

        thinq.emit('data', ENERGY_COUNTER_7)
        assert.equal(dev.energyRawCounter, 7)
        // @ts-expect-error seenUnknown is private - only reached by the generic unmodelled-frame
        // fallthrough, so its absence here proves the dedicated `10 af` branch caught it first.
        assert.equal(dev.seenUnknown.has('7:10:af'), false)

        thinq.emit('data', ENERGY_COUNTER_87)
        assert.equal(
            dev.energyRawCounter,
            87,
            'byte 2 differs (0x0f vs 0xfa) between these two real captures but is not read',
        )
    })

    test('a rise between two real energy-counter reports feeds the accumulator as 1 count = 1 Wh', async () => {
        freshEnergyDir()
        // A device id distinct from DEVICE_ID: other tests in this file emit the same real energy
        // frames too, each with their own fire-and-forget recordEnergyDelta call that could still
        // land after this test starts - a shared id would let a stray delta bleed in.
        const { ha, thinq } = makeDevice('energy-test-1')
        // First frame only establishes the baseline (7) - nothing to diff against yet. energy_hour
        // already reads 0 regardless, from energyAccumulator.attach()'s own immediate baseline
        // publish at construction (see energy-accumulator.ts's scheduleHourlyRefresh) - not this
        // frame's doing.
        thinq.emit('data', ENERGY_COUNTER_7)
        await settle()
        assert.equal(ha.devices['energy-test-1'].properties.energy_hour, 0)
        // Real second capture, counter 87 - a rise of 80.
        thinq.emit('data', ENERGY_COUNTER_87)
        await settle()
        assert.equal(ha.devices['energy-test-1'].properties.energy_hour, 80)
    })

    test('a drop in the counter (its own unpredictable reset) is accepted as a new baseline, not a negative delta', async () => {
        freshEnergyDir()
        const { ha, thinq, dev } = makeDevice('energy-test-2')
        thinq.emit('data', ENERGY_COUNTER_87)
        await settle()
        // Synthetic: same shape as the real captures above, counter dropped to 3 - simulating this
        // counter's own reset (see the file header's ENERGY COUNTER section), not 84 Wh of negative
        // consumption.
        thinq.emit('data', buf('aa0b10affa0003040400bb'))
        await settle()
        // Stays at attach()'s construction-time baseline (0) rather than a negative figure -
        // proving the drop was treated as a new baseline, not that nothing was ever published.
        assert.equal(ha.devices['energy-test-2'].properties.energy_hour, 0, 'no delta recorded for a drop')
        assert.equal(dev.energyRawCounter, 3, 'the raw counter still follows it down')

        // A subsequent rise now diffs against the new, lower baseline (3), not the pre-reset value.
        thinq.emit('data', buf('aa0b10affa0005040400bb')) // counter 5
        await settle()
        assert.equal(ha.devices['energy-test-2'].properties.energy_hour, 2, '5 - 3')
    })

    test('a single-step rise past the plausible ceiling is discarded, not counted', async () => {
        freshEnergyDir()
        const { ha, thinq, dev } = makeDevice('energy-test-3')
        thinq.emit('data', ENERGY_COUNTER_7)
        await settle()
        // Synthetic: counter 700 in one step (delta 693, past ENERGY_MAX_PLAUSIBLE_DELTA) -
        // simulating a reset that happened to land on a coincidentally higher value, not 693 Wh
        // used in one 5-minute poll interval.
        thinq.emit('data', buf('aa0b10affa02bc040400bb'))
        await settle()
        // Stays at attach()'s construction-time baseline (0) - proving the implausible delta was
        // discarded, not that nothing was ever published.
        assert.equal(ha.devices['energy-test-3'].properties.energy_hour, 0)
        assert.equal(dev.energyRawCounter, 700, 'the raw counter still follows it')
    })

    test('record[7] (anyDoorOpen) backfills both compartments to OFF once closed, but leaves an already-open one alone since it cannot say which door', () => {
        const { ha, thinq } = makeDevice()

        // Fresh device, no per-compartment event seen yet - a closed reading still corrects both,
        // matching the "why is it unknown after a restart" gap this backfill exists for.
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door_open, undefined)
        thinq.emit('data', STATE_FRIDGE_7) // record[7] raw 0 -> closed
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door_open, 'OFF', 'record[7] raw 0 -> closed')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door_open, 'OFF')

        // Both compartments now genuinely open, via the real per-compartment events.
        thinq.emit('data', FRIDGE_DOOR_OPEN)
        thinq.emit('data', FREEZER_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door_open, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door_open, 'ON')

        // record[7] raw 1 (open) can't say which compartment, so neither gets touched.
        thinq.emit('data', STATE_DOOR_OPEN_CONSTRUCTED)
        assert.equal(
            ha.devices[DEVICE_ID].properties.fridge_door_open,
            'ON',
            'unaffected - record[7] alone cannot say which door',
        )
        assert.equal(
            ha.devices[DEVICE_ID].properties.freezer_door_open,
            'ON',
            'unaffected - record[7] alone cannot say which door',
        )

        // record[7] raw 2 - still the documented "closed" quirk - corrects both back to OFF.
        thinq.emit('data', STATE_DOOR_QUIRK_2_IS_CLOSED_CONSTRUCTED)
        assert.equal(
            ha.devices[DEVICE_ID].properties.fridge_door_open,
            'OFF',
            'record[7] raw 2 -> still closed, per the documented quirk',
        )
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door_open, 'OFF')
    })

    test('per-compartment door events publish fridge_door_open and freezer_door_open independently', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', FRIDGE_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door_open, 'ON')
        assert.equal(
            ha.devices[DEVICE_ID].properties.freezer_door_open,
            undefined,
            'freezer compartment untouched so far',
        )

        thinq.emit('data', FREEZER_DOOR_OPEN)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door_open, 'ON', 'unaffected by the freezer event')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door_open, 'ON')

        thinq.emit('data', FRIDGE_DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_door_open, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door_open, 'ON', 'unaffected by the fridge event')

        thinq.emit('data', FREEZER_DOOR_CLOSED)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_door_open, 'OFF')
    })

    test('the state frame publishes the real reading, from the second (current) record', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_FRIDGE_7)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_temp, 7)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_temp, -18, 'raw 4 -> -14-4=-18')
        assert.equal(ha.devices[DEVICE_ID].properties.express_mode, 'OFF', 'raw 1 -> off')
    })

    test('a real reading corrects an optimistic guess that turns out wrong', () => {
        const { ha, thinq, dev } = makeDevice()
        // Optimistic guess says ON...
        dev.setProperty('express_mode', 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.express_mode, 'ON')
        // ...but STATE_FRIDGE_7's current record reports express raw=1 (off) - the real reading
        // must win over the optimistic guess.
        thinq.emit('data', STATE_FRIDGE_7)
        assert.equal(ha.devices[DEVICE_ID].properties.express_mode, 'OFF')
    })

    test('the state frame is read from the second record even when unrelated fields are present', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATE_EXPRESS_ON)
        assert.equal(ha.devices[DEVICE_ID].properties.fridge_temp, 4)
        assert.equal(ha.devices[DEVICE_ID].properties.freezer_temp, -18)
        assert.equal(ha.devices[DEVICE_ID].properties.express_mode, 'ON')
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
        assert.equal(ha.devices[DEVICE_ID].properties.express_mode, 'OFF')
    })
})
