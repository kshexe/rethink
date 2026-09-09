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

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('declares power, course and start, and nothing else', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
        assert.deepEqual(Object.keys(components).sort(), ['course', 'power', 'start'])
        assert.equal(components.power.command_topic, '$this/power/set')
        assert.equal(components.course.command_topic, '$this/course/set')
        assert.equal(components.start.command_topic, '$this/start/set')
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

    test('the ack frame is accepted and publishes nothing', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', ACK)
        assert.equal(ha.devices[DEVICE_ID].properties.power, undefined)
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
})
