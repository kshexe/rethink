import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/CST_570004_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf, hex } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'
import * as TLV from '@/util/tlv'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'CST_570004_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'CST_570004_WW', swVersion: '1.0' }

// Real packet captures from a CST_570004_WW ceiling-cassette IDU (multi-split).
// NB: CST emits its async/query TLV frames with UART header byte6 = 0xA7 (not 0x87);
// the base framing check only accepts 0x87, so the handler normalizes it. These captures
// keep the 0xA7 byte so the test exercises that normalization end to end.

// Capability response (query 0x1F5/1). Contains t=0x2DA (eeprom checksum) -> isCapsResponse.
// Notably 0x2CD = 2089015 (jet bits 0/1 AND positional-swing bits 4/8 all set) and
// 0x2F1 = 1 ("no filter") — both of which CST must override.
const CAPS_RESPONSE_HEX =
    '000004000000A702010077B00AB04FB0A001D5B0C1B103B4F0401011B710FEBB81BBC0BC41BC88BCC1B37' +
    '01FE037B381B54EB2E01006B7600120B85020B8903CB8D020B9103CBD600203B5C0B646B61030B5C1B646' +
    'B61030B5C2B646B61030B5C3B646B603B69037B6F0570004D41010BD30800400DD1020B5B010000064903' +
    'EFA05EFE0'

// Comprehensive state response (query 0x1F5/2). Contains t=0x1F7 (power) -> isValuesResponse.
// Captured while the IDU was powered OFF. Ground-truth tags used below:
//      0x1F7=0   power OFF
//      0x1F9=0   mode cool (reported as 'off' because power is 0)
//      0x1FA=6   fan = high (CST scale)
//      0x1FD=52  current temp = 26.0 (raw/2)
//      0x1FE=48  target temp  = 24.0 (raw/2)
//      0x20D=0   energy saving off
//      0x20E=3   auto-dry setting = 60 min
//      0x21F=200 display = 100%
//      0x225=30  auto-dry remaining = 30 min
//      0x23F=0   comfort saving off (tag present but not exposed as an entity - see the file
//                header comment in CST_570004_WW.ts for why)
//      0x290..0x3D7 = 0  wind mode = off
//      0x2B3=0   power = 0 W (compressor idle)
//      0x336=811 humidity = 81 %RH (raw/10)
const QUERY_RESPONSE_HEX =
    '000004000000A7020400837DC07E407E867F50347F90307F0086808840D4C0D500C84181408180C940A38' +
    '0A3C0A400A440F540F580F5C08340838389501E83C08FC0CD40CD00CCC0CDA0032BADA01CC6ACC0AD41B54' +
    'ED56002FBD5A00960BC88D5D03CD61020C9009C40A88087D0C8AC40E9C16640668066C067006740678067C' +
    '068008F80F7407C8189501E9380D558'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

/** Bring the device through caps -> values -> initMakeSetConfig using mock timers, so the
 *  config is installed. Returns with the thinq recorder cleared. */
function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()

    // Constructor sent the queryCaps packet; discard it.
    thinq.resetRecorder()

    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(QUERY_RESPONSE_HEX))

    // valuesReceived arms a 500 ms masking delay, after which the config is built.
    tickMockTimers(t, 600)

    thinq.resetRecorder()
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('0xA7 caps response is normalized and triggers the values query', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))

        // A plain RAC handler would drop the 0xA7 frame and never ask for values.
        assert.equal(thinq.outbox.length, 1, 'values query sent in response to caps')
        dev.drop()
    })

    test('config drops jet/heat and exposes the CST-specific components', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        const device = ha.devices[DEVICE_ID]
        assert.ok(device, 'HA configuration published')
        const c = device.config!.components as Record<string, Record<string, unknown>>

        assert.ok(c.climate, 'climate component')
        assert.equal(c.climate.platform, 'climate')

        // The captured caps had 0x2CD with the jet bits set, yet CST is cooling-only and must
        // suppress jet — and the old binary auto-dry sensor is replaced by a select.
        assert.ok(!c.jet, 'no jet switch (suppressed despite 0x2CD jet bits)')
        assert.ok(!c.autodry, 'no binary auto-dry sensor')

        // HVAC mode list excludes heat.
        assert.deepEqual(c.climate.modes, ['off', 'cool', 'dry', 'fan_only', 'auto'])

        // Temp range read from caps 0x2E1/0x2E2 (32/60 -> 16/30), not RAC's hardcoded 18.
        assert.equal(c.climate.min_temp, 16)
        assert.equal(c.climate.max_temp, 30)

        // Power saving comes from the 0x2CB feature bitmap (CST's relocated 0x2CC); the binary
        // auto-dry sensor (0x2CB bit2) is masked because auto-dry is exposed as a select instead.
        assert.ok(c.power_save, 'power_save present (from 0x2CB bit1)')

        // CST fan scale and both swing axes: swing_mode is vertical (0x205), swing_horizontal_mode
        // is horizontal (0x206) - matching lg_thinq's own pairing for this unit; see
        // swingAxesOnOff()'s own comment for why vertical carries the primary name here.
        assert.deepEqual(c.climate.fan_modes, ['auto', 'very low', 'low', 'medium', 'high', 'power'])
        assert.deepEqual(c.climate.swing_modes, ['on', 'off'])
        assert.deepEqual(c.climate.swing_horizontal_modes, ['on', 'off'])

        // Extra components CST adds.
        assert.equal(c.autodry_setting?.platform, 'select')
        assert.deepEqual(c.autodry_setting.options, ['off', '10 min', '30 min', '60 min', 'smart'])
        assert.equal(c.autodryremain?.unit_of_measurement, 'min', 'auto-dry remaining is minutes, not %')
        assert.equal(c.display?.platform, 'select')
        assert.ok(!c.comfort_saving, 'no comfort_saving entity - has no observable effect, no app control either')
        assert.equal(c.wind_mode?.platform, 'select')
        assert.equal(c.humidity?.device_class, 'humidity')
        assert.equal(c.energy_current?.device_class, 'power', 'power sensor always present, even idle')

        // Power saving rendered as a plain toggle (no assumed_state buttons).
        assert.ok(c.power_save, 'power_save present')
        assert.ok(!('optimistic' in c.power_save), 'power_save optimistic flag removed')

        // Filter usage comes from value tags 0x355/0x356, not RAC's priv-command (unpopulated on
        // CST). No RAC priv-command filter entities; a remaining % and used-time sensor instead.
        assert.ok(!c.filterused && !c.filterlife && !c.filterreset, 'no RAC priv-command filter entities')
        assert.equal(c.filter_remaining?.unit_of_measurement, '%')
        assert.equal(c.filter_used?.unit_of_measurement, 'h')

        dev.drop()
    })

    test('initial values publish the expected HA properties', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // Re-emit the values frame now that the fields are registered.
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        tickMockTimers(t, 100)

        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'off') // power 0x1F7=0
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'fan_mode_state'), 'high') // 0x1FA=6
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'current_temperature'), 26) // 0x1FD=52 /2
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 24) // 0x1FE=48 /2
        assert.equal(ha.getProperty(DEVICE_ID, 'humidity', 'state'), 81) // 0x336=811 /10
        assert.equal(ha.getProperty(DEVICE_ID, 'energy_current', 'state'), 0) // 0x2B3=0
        assert.equal(ha.getProperty(DEVICE_ID, 'autodry_setting', 'state'), '60 min') // 0x20E=3
        assert.equal(ha.getProperty(DEVICE_ID, 'autodryremain', 'state'), 30) // 0x225=30
        assert.equal(ha.getProperty(DEVICE_ID, 'display', 'state'), '100%') // 0x21F=200
        assert.equal(ha.getProperty(DEVICE_ID, 'wind_mode', 'state'), 'off') // all wind flags 0

        // Filter: 0x355=763 remaining of 0x356=2400 -> 32%, used = 2400-763 = 1637 h.
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_remaining', 'state'), 32)
        assert.equal(ha.getProperty(DEVICE_ID, 'filter_used', 'state'), 1637)

        dev.drop()
    })

    test('HVAC auto mode uses CST wire value 3, not RAC 6', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        // READ: device reports mode wire 3 while powered on -> 'auto'. RAC's table decodes wire 3
        // as undefined, so without the CST mode table this would publish no valid mode.
        dev.raw_clip_state[0x1f7] = 1
        dev.processKeyValue(0x1f9, 3)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'mode_state'), 'auto')

        // WRITE: selecting 'auto' in HA emits wire value 3 (RAC would send the unsupported 6).
        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'auto')
        assert.equal(thinq.outbox.length, 1)
        const frame = thinq.outbox[0]
        const mode = TLV.parse(frame.subarray(11, frame.length - 2)).find(({ t }) => t === 0x1f9)
        assert.equal(mode?.v, 3, 'auto writes 0x1f9=3')

        dev.drop()
    })

    test('0x1fe stops publishing as a temperature once the unit is in auto mode', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        // Baseline: cool mode, a real setpoint reads through as-is.
        dev.raw_clip_state[0x1f7] = 1
        dev.processKeyValue(0x1f9, 0) // cool
        dev.processKeyValue(0x1fe, 48)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 24)

        // Switching to auto and receiving one of its 5 comfort-offset codes (36 = offset 1, not
        // 18°C) must not overwrite the setpoint with that bogus half - see the file header's AUTO
        // MODE section and this field's own read_xform comment.
        dev.processKeyValue(0x1f9, 3) // auto
        dev.processKeyValue(0x1fe, 36)
        assert.equal(
            ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'),
            24,
            'still the last real cool-mode setpoint, not 36/2',
        )

        dev.drop()
    })

    test('0x1fe also stops publishing in fan_only, matching lg_thinq - even though the raw value is real', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        // Baseline: cool mode, a real setpoint reads through as-is.
        dev.raw_clip_state[0x1f7] = 1
        dev.processKeyValue(0x1f9, 0) // cool
        dev.processKeyValue(0x1fe, 52)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 26)

        // Unlike auto, fan_only's raw value is not bogus - checked live 2026-09-14 against the
        // same unit's own lg_thinq entity, which read `temperature: None` in fan_only at the same
        // moment this tag held a perfectly plausible 26°C. Suppressed anyway, for parity with the
        // official integration's presentation - see this field's own read_xform comment.
        dev.processKeyValue(0x1f9, 2) // fan_only
        dev.processKeyValue(0x1fe, 52)
        assert.equal(
            ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'),
            26,
            'still the last cool-mode setpoint - not republished, not cleared',
        )

        dev.drop()
    })

    test("0x1fe also stops publishing in dry, per the owner's report of lg_thinq doing the same", (t) => {
        const { ha, dev } = buildReadyDevice(t)

        dev.raw_clip_state[0x1f7] = 1
        dev.processKeyValue(0x1f9, 0) // cool
        dev.processKeyValue(0x1fe, 52)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'), 26)

        dev.processKeyValue(0x1f9, 1) // dry
        dev.processKeyValue(0x1fe, 52)
        assert.equal(
            ha.getProperty(DEVICE_ID, 'climate', 'temperature_state'),
            26,
            'still the last cool-mode setpoint - not republished',
        )

        dev.drop()
    })

    test('selecting a mode while off turns the unit on (attaches 0x1f7=1)', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        dev.raw_clip_state[0x1f7] = 0 // powered off
        ha.setProperty(DEVICE_ID, 'climate', 'mode_command', 'cool')

        assert.equal(thinq.outbox.length, 1)
        const frame = thinq.outbox[0]
        const m = new Map(TLV.parse(frame.subarray(11, frame.length - 2)).map(({ t, v }) => [t, v]))
        // Mode-only writes are ignored while off; the frame must also carry power on.
        assert.equal(m.get(0x1f7), 1, 'power on attached')
        assert.equal(m.get(0x1f9), 0, 'mode cool')

        dev.drop()
    })

    test('writing wind_mode emits an exclusive one-hot TLV', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        ha.setProperty(DEVICE_ID, 'wind_mode', 'command', 'manner')

        assert.equal(thinq.outbox.length, 1, 'one packet sent')
        const frame = thinq.outbox[0]
        const tlvs = TLV.parse(frame.subarray(11, frame.length - 2))
        const map = new Map(tlvs.map(({ t, v }) => [t, v]))

        // manner -> 0x3D6=1, every other wind flag explicitly 0.
        assert.equal(map.get(0x3d6), 1, 'manner flag set')
        assert.equal(map.get(0x290), 0)
        assert.equal(map.get(0x291), 0)
        assert.equal(map.get(0x3d5), 0)
        assert.equal(map.get(0x3d7), 0)

        dev.drop()
    })

    test('constructor sends a queryCaps packet on the wire', () => {
        const { thinq, dev } = makeDevice()
        if (dev.query_caps_timeout) {
            clearInterval(dev.query_caps_timeout)
            dev.query_caps_timeout = undefined
        }
        assert.equal(thinq.outbox.length, 1, 'queryCaps sent from constructor')
        dev.drop()
    })

    /*
     * Regression test for a real bug found 2026-09-10: knownTagIds() listed 0x20d (the
     * energy-save partner tag) but not 0x20f (air purify itself), nor 0x21a (sleeptimer) or
     * 0x221 (error code) - all three are addField'd normally, but the very first values-response
     * (received before addFeatureEntities() has run) flagged them as unmodelled once, and the
     * frame recorder's "log an unknown tag only once" dedup then kept them flagged for good even
     * after the field existed. Confirmed live against all three of the household's own units.
     */
    test('knownTagIds() recognises airclean/sleeptimer/error, not just their partner tags', (t) => {
        const { dev } = buildReadyDevice(t)
        const known = dev.knownTagIds()
        assert.ok(known.has(0x20f), 'airclean (0x20f)')
        assert.ok(known.has(0x21a), 'sleeptimer (0x21a)')
        assert.ok(known.has(0x221), 'error code (0x221)')
        dev.drop()
    })

    /*
     * Regression test for a real 2026-09-11 report: power_save/air_clean sat on "unknown" in HA
     * forever whenever the unit had been off since rethink last (re)connected to it, because
     * read_callback deliberately ignores the raw value while off/out-of-mode (see the file
     * header) and nothing else ever published anything in its place - unlike temperature/mode,
     * which always have a value regardless of power state. QUERY_RESPONSE_HEX was captured with
     * the real unit powered off, so buildReadyDevice() exercises exactly that case.
     */
    test('power_save publishes an explicit OFF, not silence, when read while the unit is off', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)
        // buildReadyDevice()'s own QUERY_RESPONSE_HEX arrived before addFeatureEntities() had
        // registered any fields (config is only built after it, per initMakeSetConfig), so it was
        // stored in raw_clip_state but never ran through a read_callback - same as real startup,
        // where initMakeSetConfig() re-queries once the config exists. Re-emit it to reach that.
        thinq.emit('data', buf(QUERY_RESPONSE_HEX))
        // The published property key carries a trailing "-" (comp + '-' + name, name === '' for
        // this field) - see addModeDependentConfigSwitchField.
        assert.equal(ha.devices[DEVICE_ID].properties['power_save-'], 'OFF')
        dev.drop()
    })

    /*
     * 상하 각도 (0x321) - see the constant's own comment in CST_570004_WW.ts for how this was
     * found (2026-09-12, live TLV capture while cycling the real unit through all 6 positions
     * and back) and CORRECTED (2026-09-15, the owner's own HA-driven retest pinning down
     * VERTICAL_ANGLE_ECHO_BASE). QUERY_RESPONSE_HEX predates the discovery and doesn't carry
     * this tag, so this test uses its own copy with 0x321 appended TWICE - once as a plain
     * write-side value (1, untouched, matching a value seen earlier in the same frame) and
     * once as this unit's OWN echo of position 3 (8736 + 3 = 8739) - the second, "current" one
     * is what the shadow field's read_callback actually reads. Rebuilt with the same
     * TLV/crc16 helpers the handler itself uses, not a hand-edited hex string.
     */
    const QUERY_RESPONSE_WITH_VERTICAL_ANGLE_HEX =
        '000004000000A7020400877DC07E407E867F50347F90307F0086808840D4C0D500C84181408180C940A38' +
        '0A3C0A400A440F540F580F5C08340838389501E83C08FC0CD40CD00CCC0CDA0032BADA01CC6ACC0AD41B54' +
        'ED56002FBD5A00960BC88D5D03CD61020C9009C40A88087D0C8AC40E9C16640668066C067006740678067C' +
        '068008F80F7407C8189501E9380C8602223B03A'

    test('vertical_angle select reads 0x321 (1..6, echo-offset by VERTICAL_ANGLE_ECHO_BASE) or "auto" when swing (0x205) is on', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_WITH_VERTICAL_ANGLE_HEX))
        tickMockTimers(t, 600)

        const c = ha.devices[DEVICE_ID].config!.components as Record<string, any>
        assert.equal(c.vertical_angle?.platform, 'select')
        assert.deepEqual(c.vertical_angle.options, ['1', '2', '3', '4', '5', '6', 'auto'])

        thinq.emit('data', buf(QUERY_RESPONSE_WITH_VERTICAL_ANGLE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'vertical_angle', 'state'), '3') // 0x321=8739 = base+3, 0x205=0

        // Swing (0x205) on wins over whatever 0x321 last held. 0x205 has its own field (driving
        // the climate entity's swing_mode), so set it directly rather than via a frame, then
        // re-process 0x321 alone to re-trigger the shadow read (a real state dump would carry
        // both together - see the read_callback's own comment for why that is relied on here).
        dev.raw_clip_state[0x205] = 1
        dev.processKeyValue(0x321, 8736 + 3)
        assert.equal(ha.getProperty(DEVICE_ID, 'vertical_angle', 'state'), 'auto')

        dev.drop()
    })

    test('an out-of-range 0x321 echo (mid-move, or an offset not yet confirmed) leaves the select alone', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_WITH_VERTICAL_ANGLE_HEX))
        tickMockTimers(t, 600)
        thinq.emit('data', buf(QUERY_RESPONSE_WITH_VERTICAL_ANGLE_HEX))
        assert.equal(ha.getProperty(DEVICE_ID, 'vertical_angle', 'state'), '3')

        // Neither a raw 1..6 (the write-side range) nor base+1..6 (the echo range) - the value
        // this correction retracted a theory about (a mid-sweep "vStep" reading). Whatever it
        // is, it is not a settled position, so the select must keep showing '3' rather than
        // publishing something outside its own options (which HA would just reject anyway) or
        // guessing 'auto'.
        dev.raw_clip_state[0x205] = 0
        dev.processKeyValue(0x321, 12345)
        assert.equal(ha.getProperty(DEVICE_ID, 'vertical_angle', 'state'), '3', 'unchanged - not republished')

        dev.drop()
    })

    test('writing vertical_angle=4 sets 0x321=4 and clears swing (0x205=0)', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_WITH_VERTICAL_ANGLE_HEX))
        tickMockTimers(t, 600)

        dev.raw_clip_state[0x205] = 1 // swing was on
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'vertical_angle', 'command', '4')

        assert.equal(thinq.outbox.length, 1)
        const frame = thinq.outbox[0]
        const m = new Map(TLV.parse(frame.subarray(11, frame.length - 2)).map(({ t, v }) => [t, v]))
        assert.equal(m.get(0x321), 4, 'angle written')
        assert.equal(m.get(0x205), 0, 'swing forced off in the same frame')

        dev.drop()
    })

    test('writing vertical_angle="auto" sets swing (0x205=1), no 0x321 write', (t) => {
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        thinq.emit('data', buf(QUERY_RESPONSE_WITH_VERTICAL_ANGLE_HEX))
        tickMockTimers(t, 600)

        dev.raw_clip_state[0x205] = 0
        thinq.resetRecorder()

        ha.setProperty(DEVICE_ID, 'vertical_angle', 'command', 'auto')

        assert.equal(thinq.outbox.length, 1)
        const frame = thinq.outbox[0]
        const tlvs = TLV.parse(frame.subarray(11, frame.length - 2))
        assert.deepEqual(
            tlvs.map(({ t, v }) => [t, v]),
            [[0x205, 1]],
            'only 0x205 is written for auto',
        )

        dev.drop()
    })

    test('swing_mode (vertical, 0x205) and swing_horizontal_mode (horizontal, 0x206) read and write independently', (t) => {
        const { ha, thinq, dev } = buildReadyDevice(t)

        dev.processKeyValue(0x205, 1)
        dev.processKeyValue(0x206, 0)
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_mode_state'), 'on')
        assert.equal(ha.getProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_state'), 'off')

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'climate', 'swing_horizontal_mode_command', 'on')
        assert.equal(thinq.outbox.length, 1)
        let m = new Map(TLV.parse(thinq.outbox[0].subarray(11, thinq.outbox[0].length - 2)).map(({ t, v }) => [t, v]))
        assert.deepEqual([...m], [[0x206, 1]], 'writing horizontal touches only 0x206')

        thinq.resetRecorder()
        ha.setProperty(DEVICE_ID, 'climate', 'swing_mode_command', 'off')
        assert.equal(thinq.outbox.length, 1)
        m = new Map(TLV.parse(thinq.outbox[0].subarray(11, thinq.outbox[0].length - 2)).map(({ t, v }) => [t, v]))
        assert.deepEqual([...m], [[0x205, 0]], 'writing vertical touches only 0x205')

        dev.drop()
    })

    test('a unit that never sends a discrete 0x321 still resolves vertical_angle, not `unknown` forever', (t) => {
        // The bug this closes: 거실's unit sat on swing the whole time it was paired and never
        // once reported a fixed 0x321 angle, so the select's own read hook (which only fires on
        // 0x321 arriving) never ran - `unknown` from pairing onward. swing_mode's read_callback
        // now republishes vertical_angle on every 0x205 report too, so the very first swing state
        // this unit ever sends is enough, with no 0x321 in sight.
        enableMockTimers(t)
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()

        thinq.emit('data', buf(CAPS_RESPONSE_HEX))
        // Carries 0x321 once (so the select gets created and knows its options) but the state
        // fixture used from here on is deliberately the plain one, which never mentions 0x321
        // again - the shape of a unit that has always been left on swing.
        thinq.emit('data', buf(QUERY_RESPONSE_WITH_VERTICAL_ANGLE_HEX))
        tickMockTimers(t, 600)

        assert.equal(ha.devices[DEVICE_ID].config!.components.vertical_angle?.platform, 'select')

        dev.processKeyValue(0x205, 1) // swing on - no further 0x321 in this test
        assert.equal(ha.getProperty(DEVICE_ID, 'vertical_angle', 'state'), 'auto')

        dev.drop()
    })
})
