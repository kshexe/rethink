import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type DeviceDiscovery } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { note as recordNote } from '../frame-recorder'

/*
 * LG Styler, ThinQ model ST_R_ETH01Y_, deviceType 203.
 *
 * NOT the same protocol as ST_B_E4H01Y_APL.ts (S5BBP) in this repo, despite being the same
 * product category - that model uses its own `f0 24`/`f0 26` opcodes with a 40-byte state
 * record. This model instead shares the AA..BB envelope and the F0 E5 settings-write opcode that
 * FX___S.ts (a front-load washer) documents in detail: `f0 e5 00 02 01 ff <n> [<key>
 * <value...>]*n`, where <n> is the number of key/value pairs that follow and KEY_POWER (0x02),
 * KEY_COURSE (0x0a), KEY_OPERATION (0x03)/OP_START (1) and KEY_RESERVE (0x7f, 16-bit) are the
 * same keys FX___S already uses for a washer. Everything below was captured directly against a
 * real unit on 2026-09-09 via my.lgthinq.com, matched to each click by timestamp against
 * rethink's on-box capture log (`/share/rethink/frames/<date>.jsonl`).
 *
 * POWER. Ack shape matches MI2D7B (minidryer) and RD20_S (dryer) byte for byte - only the
 * from-device leading byte (0x31 here) differs per appliance class.
 *
 *   to-device   aa 0d f0 e5 00 02 01 ff 01 02 <00=off|01=on> <ck> bb
 *   from-device aa 08 31 00 e5 00 <ck> bb                                (ack)
 *
 * A single from-device frame followed the ack for the one power-on captured here:
 * `aa 0d 31 e6 00 02 01 ff 01 02 11 b1 bb`. At a glance its shape matches the ack-plus-echo
 * pattern the write itself has - `e6 00 02 01 ff 01 02` is exactly the sent command with e5
 * turned into e6 - which is what the send/start echo below confirms this opcode does elsewhere.
 * But the byte in the state position is 0x11, not 0x01, despite this being a plain ON with
 * nothing else requested - so it is NOT simply the 0/1 KEY_POWER carried straight through, and
 * with one capture there is nothing to separate "some other bit is also set here" from "this
 * position means something else entirely" from "the echo for THIS key doesn't mirror the
 * command's own value the way FX___S's does for its own keys". Guessing which would be
 * inventing a decode this handler cannot back up, so `power` is published optimistically from
 * the command this handler itself just sent (see setProperty) rather than read off the wire -
 * the same call MI2D7B.ts and RD20_S.ts make for their own, differently-shaped, unreadable
 * echo.
 *
 * COURSE SELECT vs START. Pressing "스타일러에 전송" (queue the course, no start) produces a
 * 3-key write; pressing "시작" (start) after 원격제어 (remote control) was armed at the appliance
 * produces the same write with a 4th key (KEY_OPERATION/OP_START) appended:
 *
 *   send   f0 e5 00 02 01 ff 03  0a <courseId>  23 00  7f 00 00
 *   start  f0 e5 00 02 01 ff 04  0a <courseId>  23 00  7f 00 00  03 01
 *
 * "send" alone was confirmed to reach the appliance (ack + echo with recalculated time fields)
 * regardless of 원격제어 state - only START is gated. Key 0x23 was 0x00 in every capture and its
 * meaning is unconfirmed (reproduced literally, the way FX___S reproduces its own KEY_UNKNOWN_43).
 * Key 0x7f is FX___S's KEY_RESERVE, a 16-bit delay-end reservation - 0 in every capture, since
 * none was ever armed here.
 *
 * COURSE ID SWEEP (2026-09-09). All 41 courses in the app's course picker were clicked through
 * against the real unit (run, then paused) to see the protocol handle real starts, but only a
 * subset of the resulting frames could be reliably attributed to a specific course NAME - the app
 * frequently auto-starts a course the instant its "코스를 바꿀까요?" change-confirmation is
 * accepted (before any separate "시작" tap), so a same-second retry click sometimes lands on the
 * device's own PAUSE button instead of sending anything, which breaks naive timestamp-based
 * reconstruction after the fact. Only the 10 below were confirmed with an unambiguous, single
 * matching frame (either captured live with an immediate log check, or - for the first two -
 * captured while 원격제어 was still off, so nothing else could have raced with them):
 *
 *   0x01 = 표준 스타일링       0x09 = 미세먼지 제거      0x1C = 담요 데우기
 *   0x02 = 인공지능 스타일링   0x0A = 표준 살균          0x1D = 목도리 스타일링
 *   0x03 = 급속 스타일링       0x0B = 바이러스 살균
 *   0x04 = 강력 스타일링       0x1B = 눈/비 건조
 *
 * (강력 스타일링 is also the appliance's own default course.) The remaining ~31 named courses
 * each produced a start frame during the sweep too, but which id belongs to which name could not
 * be reconstructed with confidence - see rethink_migration_status memory for the raw frame-log
 * timeline. The sweep was also cut short by a real "급수통을 확인해 주세요" (refill the water
 * tank) fault the appliance raised partway through re-verification, which blocks further course
 * starts until the tank is refilled. The select below only offers the 10 confirmed courses on
 * purpose: guessing an id for an unswept course would risk starting the wrong one.
 */

const FROM_DEVICE_ACK_OPCODE = 0xe5

/** Shared with FX___S.ts's vocabulary for the same F0E5 protocol family. */
const KEY_POWER = 0x02
const KEY_OPERATION = 0x03
const OP_START = 0x01
const KEY_COURSE = 0x0a
const KEY_RESERVE = 0x7f
/** Always 0x00 in every capture so far; meaning unconfirmed, reproduced literally. */
const KEY_UNKNOWN_23 = 0x23

/** The only course ids confirmed against a real unit; see file header. */
const COURSES: Record<string, number> = {
    '강력 스타일링': 0x04,
    '표준 살균': 0x0a,
    '바이러스 살균': 0x0b,
    '인공지능 스타일링': 0x02,
    '표준 스타일링': 0x01,
    '미세먼지 제거': 0x09,
    '급속 스타일링': 0x03,
    '눈/비 건조': 0x1b,
    '담요 데우기': 0x1c,
    '목도리 스타일링': 0x1d,
}
const COURSE_BY_ID: Record<number, string> = Object.fromEntries(Object.entries(COURSES).map(([k, v]) => [v, k]))
const DEFAULT_COURSE = COURSES['강력 스타일링']

type Pair = [key: number, value: number | [hi: number, lo: number]]

/** Builds the `f0 e5 00 02 01 ff <n> [<key> <value>]*n` payload AABBDevice.send() wraps and
 *  checksums. A 2-tuple value writes a 16-bit big-endian field (only KEY_RESERVE uses one so
 *  far, per FX___S's own documentation of that key). */
function buildSettingsWrite(pairs: Pair[]): Buffer {
    const body = [0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff, pairs.length]
    for (const [key, value] of pairs) {
        body.push(key)
        if (Array.isArray(value)) body.push(value[0], value[1])
        else body.push(value)
    }
    return Buffer.from(body)
}

export default class Device extends AABBDevice {
    power: boolean | undefined
    /** The course a `start` command will use next; defaults to the appliance's own default. */
    selectedCourse: number = DEFAULT_COURSE

    /** (dir:tag) pairs already flagged as unrecognised, so a repeating one is noted once. */
    private seenUnknown = new Set<string>()

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Styler' }),
            components: {
                power: {
                    platform: 'switch',
                    unique_id: '$deviceid-power',
                    state_topic: '$this/power',
                    command_topic: '$this/power/set',
                    name: '',
                    icon: 'mdi:hanger',
                },
                course: {
                    platform: 'select',
                    unique_id: '$deviceid-course',
                    state_topic: '$this/course',
                    command_topic: '$this/course/set',
                    name: 'Course',
                    icon: 'mdi:tshirt-crew-outline',
                    options: Object.keys(COURSES),
                },
                start: {
                    platform: 'button',
                    unique_id: '$deviceid-start',
                    command_topic: '$this/start/set',
                    name: 'Start',
                    icon: 'mdi:play',
                },
            },
        })

        this.setConfig(config)
        this.publishProperty('course', COURSE_BY_ID[this.selectedCourse])
        log('status', this.id, 'ST_R_ETH01Y_ (스타일러) handler started - power, course select, start; see file header')
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'power': {
                const on = mqttValue === 'ON'
                this.send(buildSettingsWrite([[KEY_POWER, on ? 1 : 0]]))
                // Optimistic - see the file header for why the echo is not read back off the wire.
                this.power = on
                this.publishProperty('power', on ? 'ON' : 'OFF')
                return
            }
            case 'course': {
                const id = COURSES[mqttValue]
                if (id === undefined) {
                    console.warn(`ST_R_ETH01Y_: unknown course "${mqttValue}"`)
                    return
                }
                this.selectedCourse = id
                this.publishProperty('course', mqttValue)
                return
            }
            case 'start':
                // Reproduces the captured start frame exactly: course select + reserve(0) +
                // operation=start, all in one write - see file header for why this is a single
                // frame rather than "select" then a separate "start" write.
                return this.send(
                    buildSettingsWrite([
                        [KEY_COURSE, this.selectedCourse],
                        [KEY_UNKNOWN_23, 0],
                        [KEY_RESERVE, [0, 0]],
                        [KEY_OPERATION, OP_START],
                    ]),
                )
            default:
                console.warn(`ST_R_ETH01Y_: attempting to set unknown property ${prop}`)
        }
    }

    processAABB(buf: Buffer) {
        // ack: <sub> 00 e5 00  (4 bytes) - nothing to publish, just confirms the write landed
        if (buf.length === 4 && buf[1] === 0x00 && buf[2] === FROM_DEVICE_ACK_OPCODE && buf[3] === 0x00) return

        // Anything else (the power/course/start echoes, status dumps, course table) is not
        // parsed yet - see the file header for why the power echo specifically is not readable
        // with confidence from one capture. Note it once per shape so a future session has
        // something to grep for, the same way TLVDevice.noteUnknownTags does for the AC family.
        //
        // Two shapes decoded 2026-09-09 from a day of real traffic (buf[0..1] = 0x31 0x0a on
        // all of these, buf here already has AA/len stripped off the front and checksum/BB off
        // the back):
        //   - len 86/87 (by far the most common - 454 of ~600 samples that day) is NOT live
        //     status: it carries readable ASCII course/program names (ST-1, ST-2, 203-Q1,
        //     203-2, 203-3, 203-6, 203-7, 203-8, 203-Q3, 203-Q4 in one capture) - a static
        //     downloadable-course-name table the appliance just resends periodically, the same
        //     kind of frame ST_B_E4H01Y_APL.ts (upstream, a different styler protocol) calls
        //     out as its "112/113-byte downloadable-course name lists". Not worth modelling as
        //     a sensor - the content barely changes.
        //   - len 30/50/101/141 look like real status (byte values move a lot sample to sample,
        //     unlike the two above), but this model's frame layout does not match
        //     ST_B_E4H01Y_APL's fixed header(13)+record(40 bytes) shape, so no field offsets are
        //     confirmed yet. Needs the same real-time "change one thing, check immediately"
        //     method used for the course IDs - blocked for now on the water-tank fault.
        const key = buf.length > 0 ? `${buf.length}:${buf[0].toString(16)}:${(buf[1] ?? 0).toString(16)}` : 'empty'
        if (!this.seenUnknown.has(key)) {
            this.seenUnknown.add(key)
            log('status', this.id, `ST_R_ETH01Y_: unrecognised frame shape (len=${buf.length}, buf[0..1]=${key})`)
            recordNote(this.id, this.thinq.meta, 'unmodelled-aabb-frame', { len: buf.length, head: key })
        }
    }
}
