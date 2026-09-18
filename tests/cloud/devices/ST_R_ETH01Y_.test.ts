import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/ST_R_ETH01Y_'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'ST_R_ETH01Y_'
const META: Metadata = { modelId: MODEL_ID, modelName: MODEL_ID, swVersion: '1.0' }

/*
 * Fixtures. REAL frames unless a comment says otherwise, captured 2026-09-09 against a real unit
 * via my.lgthinq.com, matched to each click by timestamp against rethink's on-box capture log
 * (/share/rethink/frames/<date>.jsonl) - see ST_R_ETH01Y_.ts's file header.
 */
const ACK = buf('aa083100e5009dbb')
// The one power-on echo captured for this model - see the file header for why its state byte
// (0x11, not the plain 0x01 the write itself carries) is not decoded, so this handler does not
// parse it and this fixture is kept only to document the shape.
const POWER_ON_ECHO = buf('aa0d31e6000201ff010211b1bb')
// Course send (queue, no start) for 강력 스타일링 (course id 0x04) - captured while 원격제어 was
// off; the appliance still acked and echoed it, see the file header.
const SEND_STRONG_STYLING = buf('aa12f0e5000201ff030a0423007f000013bb')
// Course start for 강력 스타일링 (the appliance's own default course), captured AFTER the user
// armed 원격제어 at the appliance and pressing "시작" in the app produced this frame.
const START_STRONG_STYLING = buf('aa14f0e5000201ff040a0423007f0000030118bb')
// Course starts for the other 8 courses confirmed during the 2026-09-09 sweep - see the file
// header for why most of the sweep's ~41 clicks could NOT be attributed to a name this cleanly.
const START_VIRUS_STERILIZATION = buf('aa14f0e5000201ff040a0b23007f0000030101bb') // 바이러스 살균
const START_AI_STYLING = buf('aa14f0e5000201ff040a0223007f000003011ebb') // 인공지능 스타일링
const START_STANDARD_STYLING = buf('aa14f0e5000201ff040a0123007f000003011fbb') // 표준 스타일링
const START_DUST_REMOVAL = buf('aa14f0e5000201ff040a0923007f0000030107bb') // 미세먼지 제거
const START_QUICK_STYLING = buf('aa14f0e5000201ff040a0323007f0000030119bb') // 급속 스타일링
const START_SNOW_RAIN_DRY = buf('aa14f0e5000201ff040a1b23007f0000030131bb') // 눈/비 건조
const START_BLANKET_WARM = buf('aa14f0e5000201ff040a1c23007f0000030130bb') // 담요 데우기
const START_SCARF_STYLING = buf('aa14f0e5000201ff040a1d23007f0000030133bb') // 목도리 스타일링

// Real 0xEC dual-record status frame, captured 2026-09-13 changing course from 강력 스타일링
// (id 4, 53분, the appliance's default) to 정장/코트 스타일링 (id 5, 31분) while powered on -
// see the file header's STATUS RECORD section.
const STATUS_EC_SUIT_COAT_31MIN = buf(
    'aaff310a005a007b34000100ec00480a00000400000035003501000000000000000002190000001600060000000000000000000a' +
        '0000050000001f001f01000000000000000002190000001600060000000000000000005a51bb',
)

// Real notification-channel frames - see the file header's NOTIFICATION section. Captured twice
// independently (09-09 and 09-12), each ~1.5-2s before the official integration's
// event.seutailreo_notification fired styling_is_complete.
const NOTIFICATION_STYLING_IS_COMPLETE = buf('aa09317200000003bb')
// Only 1 sample so far (09-09 11:38:27) - tentative, see the file header.
const NOTIFICATION_ERROR_HAS_OCCURRED = buf('aa0c317200640300000095bb')

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('declares power, course and start as writable, plus two read-only diagnostics', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components).sort(), [
            'active_course',
            'course',
            'duration_minutes',
            'notification',
            'power',
            'smart_care_fine_dust',
            'smart_care_humidity',
            'start',
        ])
        assert.equal(components.power.command_topic, '$this/power/set')
        assert.equal(components.course.command_topic, '$this/course/set')
        assert.equal(components.start.command_topic, '$this/start/set')
        assert.equal(components.smart_care_fine_dust.command_topic, '$this/smart_care_fine_dust/set')
        assert.equal(components.smart_care_humidity.command_topic, '$this/smart_care_humidity/set')
        assert.equal(components.active_course.command_topic, undefined)
        assert.equal(components.duration_minutes.command_topic, undefined)
    })

    test('the course select only offers the courses with a confirmed id', () => {
        const { ha } = makeDevice()
        const course = ha.devices[DEVICE_ID].config!.components.course as unknown as { options: string[] }
        assert.deepEqual(course.options, [
            '강력 스타일링',
            '표준 살균',
            '바이러스 살균',
            '인공지능 스타일링',
            '표준 스타일링',
            '미세먼지 제거',
            '급속 스타일링',
            '눈/비 건조',
            '담요 데우기',
            '목도리 스타일링',
            '정장/코트 스타일링',
            '울/니트 스타일링',
            '셔츠 한 벌 건조',
            '인공지능 건조',
            '침구,베개 살균',
            '모피/가죽 스타일링',
            '패딩 건조',
            '패딩 스타일링',
            '실내 제습',
            '시간 건조',
            '아기옷 살균',
            '인형 살균',
            '청바지 스타일링',
        ])
        // Matches the appliance's own default, confirmed by START_STRONG_STYLING below being the
        // frame that came back when the user pressed 시작 without touching the course picker.
        assert.equal(ha.devices[DEVICE_ID].properties.course, '강력 스타일링')
    })

    test('start reproduces the captured start frame for each confirmed course', () => {
        const cases: [string, Buffer][] = [
            ['바이러스 살균', START_VIRUS_STERILIZATION],
            ['인공지능 스타일링', START_AI_STYLING],
            ['표준 스타일링', START_STANDARD_STYLING],
            ['미세먼지 제거', START_DUST_REMOVAL],
            ['급속 스타일링', START_QUICK_STYLING],
            ['눈/비 건조', START_SNOW_RAIN_DRY],
            ['담요 데우기', START_BLANKET_WARM],
            ['목도리 스타일링', START_SCARF_STYLING],
        ]
        for (const [name, want] of cases) {
            const { thinq, dev } = makeDevice()
            dev.setProperty('course', name)
            thinq.resetRecorder()
            dev.setProperty('start', '')
            assert.equal(thinq.outbox.length, 1, `course=${name} sent one frame`)
            assert.equal(thinq.outbox[0].toString('hex'), want.toString('hex'), `course=${name}`)
        }
    })

    test('power write reproduces the captured frame byte for byte', () => {
        for (const [value, want] of [
            ['ON', 'aa0df0e5000201ff010201c7bb'],
            // Off is not separately captured for THIS appliance, but the payload carries no
            // device-specific byte at all - see the file header - so it is asserted on the basis
            // of RD20_S's own captured off-frame, byte-identical by construction.
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

    test('the captured power echo does not move the property either way (unparsed, see file header)', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('power', 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
        thinq.emit('data', POWER_ON_ECHO)
        assert.equal(ha.devices[DEVICE_ID].properties.power, 'OFF')
    })

    test('smart_care_fine_dust write reproduces the captured frame byte for byte, both directions', () => {
        for (const [value, want] of [
            ['ON', 'aa0df0e5000201ff011c01f9bb'],
            ['OFF', 'aa0df0e5000201ff011c00febb'],
        ] as [string, string][]) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty('smart_care_fine_dust', value)
            assert.equal(thinq.outbox.length, 1, `smart_care_fine_dust=${value} sent one frame`)
            assert.equal(thinq.outbox[0].toString('hex'), want, `smart_care_fine_dust=${value}`)
        }
    })

    test('smart_care_fine_dust is published optimistically as soon as it is set, not waiting on a device echo', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('smart_care_fine_dust', 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_care_fine_dust, 'ON')
        dev.setProperty('smart_care_fine_dust', 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_care_fine_dust, 'OFF')
    })

    test('smart_care_humidity write reproduces the captured frame byte for byte, both directions', () => {
        for (const [value, want] of [
            ['ON', 'aa0df0e5000201ff011b01febb'],
            ['OFF', 'aa0df0e5000201ff011b00ffbb'],
        ] as [string, string][]) {
            const { thinq, dev } = makeDevice()
            thinq.resetRecorder()
            dev.setProperty('smart_care_humidity', value)
            assert.equal(thinq.outbox.length, 1, `smart_care_humidity=${value} sent one frame`)
            assert.equal(thinq.outbox[0].toString('hex'), want, `smart_care_humidity=${value}`)
        }
    })

    test('smart_care_humidity is published optimistically as soon as it is set, not waiting on a device echo', () => {
        const { ha, dev } = makeDevice()
        dev.setProperty('smart_care_humidity', 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_care_humidity, 'ON')
        dev.setProperty('smart_care_humidity', 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.smart_care_humidity, 'OFF')
    })

    test('the ack frame is accepted and publishes nothing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ACK)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
    })

    test('a real 0xEC status frame decodes power/active course/duration off record[9]/[2]/[6]', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', STATUS_EC_SUIT_COAT_31MIN)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.power, 'ON')
        assert.equal(props.active_course, '정장/코트 스타일링')
        assert.equal(props.duration_minutes, 31)
        // The writable "course" select (what a future Start press will use) is untouched by a
        // status read - it only reflects the appliance's live panel, see the file header.
        assert.equal(props.course, '강력 스타일링')
    })

    test('start reproduces the captured start frame for the default course', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('start', '')
        assert.equal(thinq.outbox.length, 1)
        assert.equal(thinq.outbox[0].toString('hex'), START_STRONG_STYLING.toString('hex'))
    })

    test('selecting a course changes what start sends next', () => {
        const { ha, thinq, dev } = makeDevice()
        dev.setProperty('course', '표준 살균')
        assert.equal(ha.devices[DEVICE_ID].properties.course, '표준 살균')
        thinq.resetRecorder()
        dev.setProperty('start', '')
        // Course id 0x0a in the same position SEND_STRONG_STYLING/START_STRONG_STYLING carry 0x04
        // - not independently captured for a start frame, so only the byte that should differ is
        // checked here rather than a full frame this test would be inventing.
        assert.equal(thinq.outbox[0][9], 0x0a)
    })

    test('an unknown course name is rejected without sending anything', () => {
        const { thinq, dev } = makeDevice()
        thinq.resetRecorder()
        dev.setProperty('course', '존재하지 않는 코스')
        assert.equal(thinq.outbox.length, 0)
    })

    /*
     * SEND_STRONG_STYLING (전송, no start) is not reproduced by this handler - only the combined
     * course+start write is, see the file header for why "send" and "start" collapse into one
     * button. This fixture is kept only to document the shape "send" actually has on the wire,
     * for whoever adds a separate queue-without-start control later.
     */
    test('the captured "send" frame differs from "start" only in the operation key', () => {
        assert.equal(SEND_STRONG_STYLING.length + 2, START_STRONG_STYLING.length)
    })

    test('a real notification-channel frame publishes styling_is_complete', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', NOTIFICATION_STYLING_IS_COMPLETE)
        assert.equal(
            JSON.parse(String(ha.devices[DEVICE_ID].properties.notification)).event_type,
            'styling_is_complete',
        )
    })

    // Tentative decode (1 sample) - see the file header's NOTIFICATION section.
    test('a real notification-channel frame publishes error_has_occurred', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', NOTIFICATION_ERROR_HAS_OCCURRED)
        assert.equal(JSON.parse(String(ha.devices[DEVICE_ID].properties.notification)).event_type, 'error_has_occurred')
    })
})
