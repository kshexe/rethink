import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import DUT from '@/cloud/devices/MI2D7B'
import type { Metadata } from '@/cloud/thinq'
import { configure as configureEnergyAccumulator } from '@/cloud/energy-accumulator'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'MI2D7B'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

/** energy-accumulator.ts persists to disk and caches by device id - point it at a fresh scratch
 *  dir (which also clears its cache) so each energy test starts from nothing, the same way
 *  RD20_S.test.ts/2REF21EBNSX_3.test.ts/3REK2G03VI200S_2.test.ts isolate themselves, and so these
 *  tests never touch the real /share/rethink/energy path. */
function freshEnergyDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mi2d7b-energy-test-'))
    configureEnergyAccumulator(dir)
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
}

/** recordDelta() is fire-and-forget (`void ...`) from processAABB, so its file I/O has not
 *  necessarily landed yet the instant `thinq.emit` returns - give it a beat. */
async function settle() {
    await new Promise((r) => setTimeout(r, 50))
}

/*
 * Fixtures. All REAL frames, captured 2026-09-09 against a real unit by clicking the power
 * switch on my.lgthinq.com and reading rethink's on-box capture log
 * (/share/rethink/frames/<date>.jsonl) for the same timestamp - see MI2D7B.ts's file header.
 */
const ACK = buf('aa082000e500e2bb')
// The 61-byte from-device frame that follows the ack. Looks like a power echo at a glance - it
// is not one, see the file header - so this handler must treat it the same as any other
// unrecognised frame rather than reading (wrongly) that power is off.
const BUNDLED_STATUS = buf(
    'aa3d20e6000201ff01020000000002132e00000000000000003300000000002e01008100000000080000000000000000020020300000000000000027bb',
)
// Real 0xEC dual-record status frame, captured 2026-09-13 mid-cycle - see the file header's
// REMAINING_MINUTES section. record[13] of the "new" half reads 28 (0x1c).
const STATUS_EC_28_MIN_LEFT = buf(
    'aaff200a0072009a01000100ec006000001702136100000000000000001d00630348002e0c0b8100000000080000000000000008100100300000000000000000001702136100000000000000001c00630348002e0c0b81000000000800000000000000081001003000000000000000462bbb',
)
// Real notification-channel frames - see the file header's NOTIFICATION section. Captured twice
// independently (2026-09-13, 02:47 and 09:06), each ~1.3-1.4s before the official integration's
// event.miniweosi_notification fired washing_is_complete.
const NOTIFICATION_CODE_00 = buf('aa09207200000010bb')
const NOTIFICATION_CODE_C8 = buf('aa09207200c80058bb')

// Real energy-report frames - see the file header's ENERGY section. Both are real captures
// (2026-09-13T01:13:38Z and 2026-09-13T08:35:43Z), each report #1 of its own cycle (delta ===
// total, since the running total resets to 0 at cycle start).
const ENERGY_REPORT_1_156WH = buf('aa0b203e009c009c0119bb')
const ENERGY_REPORT_1_21WH = buf('aa0b203e00150015016bbb')

function makeDevice(id = DEVICE_ID) {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(id, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('declares power as the only writable component, plus remaining_minutes/remaining_display/energy*/notification read-only', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components), [
            'power',
            'remaining_minutes',
            'remaining_display',
            'energy',
            'energy_hour',
            'energy_day',
            'energy_month',
            'notification',
        ])
        assert.equal(components.power.command_topic, '$this/power/set')
        assert.equal(components.remaining_minutes.command_topic, undefined)
    })

    /*
     * REAL: captured off a real unit turning power on. Off is not separately captured for THIS
     * appliance, but the payload bytes (and therefore the checksum) are identical to RD20_S's own
     * captured off-frame - the write carries no device-specific byte at all, see MI2D7B.ts's file
     * header - so it is asserted here on that basis rather than a fresh guess.
     */
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

    test('a real query-response status frame publishes remaining_minutes', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_EC_28_MIN_LEFT)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_minutes, 28)
    })

    test('remaining_display follows power, off before on', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('power', 'ON')
        thinq.emit('data', STATUS_EC_28_MIN_LEFT)
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_display, '28분')
        dev.setProperty('power', 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.remaining_display, '-')
    })

    test('both real notification-channel codes publish washing_is_complete', () => {
        for (const frame of [NOTIFICATION_CODE_00, NOTIFICATION_CODE_C8]) {
            const { ha, thinq } = makeDevice()
            thinq.emit('data', frame)
            assert.equal(
                JSON.parse(String(ha.devices[DEVICE_ID].properties.notification)).event_type,
                'washing_is_complete',
            )
        }
    })

    test('a real energy report publishes the running total as energy (this cycle)', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ENERGY_REPORT_1_156WH)
        assert.equal(ha.devices[DEVICE_ID].properties.energy, 156)
    })

    test("a real energy report's delta feeds the calendar-boundary buckets", async () => {
        freshEnergyDir()
        // A device id distinct from DEVICE_ID: other tests in this file emit real frames too,
        // each with their own fire-and-forget recordDelta call that could still land after this
        // test starts - a shared id would let a stray delta bleed in, same reasoning as this
        // fork's other energy tests.
        const { ha, thinq } = makeDevice('energy-test-1')
        thinq.emit('data', ENERGY_REPORT_1_156WH)
        await settle()
        assert.equal(ha.devices['energy-test-1'].properties.energy_hour, 156)
        // Second real capture, a different cycle's own report #1 (delta=21) - each report's delta
        // is read straight off the wire, not diffed against a stored previous value, so this adds
        // onto the first rather than replacing it.
        thinq.emit('data', ENERGY_REPORT_1_21WH)
        await settle()
        assert.equal(ha.devices['energy-test-1'].properties.energy_hour, 177, '156 + 21')
        assert.equal(
            ha.devices['energy-test-1'].properties.energy,
            21,
            "this cycle now reads the second report's own total",
        )
    })
})
