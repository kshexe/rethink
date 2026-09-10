import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type DeviceDiscovery } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { note as recordNote } from '../frame-recorder'

/*
 * LG combi oven (광파오븐), ThinQ model ML32PWFOTA, deviceType 301.
 *
 * Shares the AA..BB envelope (see aabb_device.ts) with a `f0 43` "course send" opcode and a
 * `f0 44 00` cancel opcode. Everything below was captured 2026-09-10 by driving my.lgthinq.com
 * directly and matching each click to rethink's on-box capture log by timestamp - the user
 * confirmed remote course-send is inherently safe to script this way: the appliance never
 * actually starts heating from `f0 43` alone, it only queues the course and shows "오븐에서
 * '시작' 버튼을 누르세요" (press Start on the oven) - a physical button press is required to
 * begin cooking, matching the send-vs-start split already established for the dryer/styler.
 * This handler therefore only ever sends the "queue" frame, never a "start" - there is no wire
 * command captured (or believed to exist) that starts the oven remotely.
 *
 * SEND: `aa 4c f0 43 <70-byte body> <ck> bb` (76 bytes total). Body layout (offsets below are
 * into the 72-byte `inner` buffer AABBDevice.send() is given, i.e. starting right after the f0 43
 * opcode bytes):
 *   inner[2..6]   = 01 01 01 00 00                       constant in every capture, unconfirmed
 *   inner[7]      = cook time, quotient  (totalSeconds // 100)
 *   inner[8]      = cook time, remainder (totalSeconds % 100)
 *   inner[9]      = 00                                    constant, unconfirmed
 *   inner[10]     = target temperature in Celsius (0 for 레인지/microwave, which has no temp)
 *   inner[11..15] = 00 00 00 00 00                        constant, unconfirmed
 *   inner[16]     = increments by ~1-4 on every send regardless of course/time - a session/
 *                   sequence counter, not a course parameter. Reproduced literally from
 *                   whichever course template was captured; never independently incremented by
 *                   this handler, since there is no evidence the appliance validates it.
 *   inner[17..59] = 00 (reserved / unconfirmed - rack position and accessory selection almost
 *                   certainly live in here, since the UI exposes "단 위치"/"부속품" per course,
 *                   but no single-variable capture isolated them - each course template below
 *                   just reproduces the UI's own default rack/accessory choice for that course)
 *   inner[60], inner[62..65] = course selector bytes (5 bytes, not a single scalar id - see
 *                   COURSE TABLE below)
 *
 * Time encoding (isolated 2026-09-10 via three clean single-variable captures: default 20분0초,
 * changed to 21분5초, changed to 5분0초 - only inner[7]/inner[8] moved): total cook time in
 * seconds splits as `inner[7] = totalSeconds // 100`, `inner[8] = totalSeconds % 100`. The web
 * UI's time picker only offers 5-second steps (0,5,...,55) and 0-50 minutes for 구이 - the only
 * course whose slider bounds were directly observed - so this handler clamps every course to the
 * same 0-50 min / 5-second-step range for lack of a captured range specific to the others.
 *
 * ACK: `aa 08 40 00 43 00 <ck> bb` for a send, `aa 08 40 00 44 00 <ck> bb` for a cancel - both
 * just confirm the write landed, nothing to publish. A `40 ec ...` state-echo frame follows each
 * (`aa 3e 40 ec <56-byte body: two 28-byte records, old then new> <ck> bb`, the same old/new
 * pairing the fridge's `10 ec` uses).
 *
 * STATE (decoded 2026-09-10 by cross-referencing the official `lg_thinq` integration's own
 * `sensor.gwangpaobeun_current_status`/`sensor.gwangpaobeun_temperature` entities - which keep
 * receiving real data because rethink's bridge mode also relays this appliance's traffic to LG's
 * real cloud in parallel, see bridge/index.ts's `BridgedDevice` - against rethink's raw `40 ec`
 * frames at the same instant, for every send/cancel done while building the course table above).
 * Within each 28-byte record:
 *   record[0]  = status: `0x00` when the official sensor read "initial" (idle/cancelled), `0x07`
 *                whenever it read "preference" (a course is queued, matches the UI's "전송 완료"
 *                state) - every send/cancel pair flipped both in lockstep, confirmed across 8
 *                independent transitions including a 레인지 (microwave, temp=0) one, so this is
 *                not merely correlated with the temperature field below.
 *   record[1]  = `0x13` whenever status is "preference", `0x00` whenever "initial" - moves with
 *                record[0] in every capture; kept as a second read of the same transition rather
 *                than merged into one field, since nothing confirms they're not independently
 *                significant (e.g. once an actual cook start becomes reachable to capture).
 *   record[6]  = target temperature in Celsius - confirmed byte-for-byte equal to the official
 *                sensor's live value for both 180 (오븐) and 40 (식품건조) sends, and 0 for the
 *                temp-less 레인지 send.
 *   record[7]  = `0x04` whenever status is "preference" (even for 레인지's temp=0 case, so this
 *                is not a "has a temperature" flag), `0x00` whenever "initial".
 *   record[8]  = `0x01` only in the idle/"initial" record, `0x00` otherwise - the mirror image of
 *                record[0], reproduced literally since nothing yet explains why the appliance
 *                repeats the idle/non-idle distinction at two separate offsets.
 *   record[2..5,9..27] = `0x00` in every capture so far.
 * Only "initial" and "preference" have ever been observed - a real cook can only be started by a
 * physical button press (see above), so no capture exists yet for what the appliance reports
 * while actually cooking, paused, or finished. `current_status` below passes through any other
 * status byte as a plain `unknown_<n>` string rather than guessing a name for it.
 *
 * CANCEL/STOP: `aa 07 f0 44 00 <ck> bb` - clicking "전송 취소" in the UI. Confirmed to cancel a
 * pending queued course (used repeatedly during capture to back out of every test send below).
 *
 * COURSE TABLE (all 6 entries in the app's 요리 모드 picker, each captured at its own UI
 * default time/temp - only inner[7]/inner[8]/inner[16] were overwritten by this handler's own
 * time control, everything else is byte-for-byte what the real UI sent):
 *
 *   구이(grill)      20:00 230C  courseBytes(60,62,63,64,65) = 04,04,02,0a,01
 *   레인지(microwave) 1:00   -   courseBytes                = 00,04,02,00,03
 *   오븐(oven)       20:00 180C  courseBytes                = 01,04,02,0a,04
 *   스팀(steam)      10:00 105C  courseBytes                = 01,04,01,08,04
 *   식품건조(dehydrate) 1:40 40C courseBytes                = 01,05,02,0a,04
 *   발효(ferment)     0:40 40C   courseBytes                = 01,05,02,0a,04
 *
 * 식품건조 and 발효 share byte-for-byte identical course selector bytes (confirmed by diffing
 * their two captures down to every byte outside the time field and the send counter) - on the
 * wire they appear to be the same underlying oven mode, distinguished only by the app's differing
 * suggested default cook time. Reproduced as-is rather than guessed away.
 *
 * NOT-YET-DECODED: rack position (단 위치) and accessory (부속품) selection - each course above
 * bakes in whatever the UI's own default was, not independently controllable here. The `40 ec`
 * state-echo record layout. Also 스팀 mode pops a "물통을 채워주세요" (fill the water tank)
 * confirm dialog in the UI before it will send - not reproduced or needed here since this
 * handler only ever queues a course, never starts one.
 */

const ACK_OPCODE_SEND = 0x43
const ACK_OPCODE_CANCEL = 0x44
const STATE_OPCODE_HI = 0x40
const STATE_OPCODE_LO = 0xec
const STATE_RECORD_LEN = 28

/** record[0] values confirmed against the official lg_thinq integration's own status strings -
 *  see the file header's STATE section. Anything else is passed through as `unknown_<n>`. */
const STATUS_NAMES: Record<number, string> = {
    0x00: 'initial',
    0x07: 'preference',
}
function decodeStatus(b: number): string {
    return STATUS_NAMES[b] ?? `unknown_${b}`
}

const MIN_MINUTES = 0
const MAX_MINUTES = 50
const SECOND_STEP = 5
const MAX_SECONDS = 55

/** Each entry is the exact 72-byte `inner` buffer captured for that course's own UI default -
 *  see the file header's COURSE TABLE. `defaultTotalSeconds` is only used to reset the time
 *  controls when the user switches course, matching the web UI resetting its own time picker. */
const COURSES: Record<string, { inner: Buffer; defaultTotalSeconds: number }> = {
    구이: {
        inner: Buffer.from(
            'f04301010100000c0000e600000000006600000000000000000000000000000000000000000000000000000000000000000000000000000000010000040704020a01000004000000',
            'hex',
        ),
        defaultTotalSeconds: 20 * 60,
    },
    레인지: {
        inner: Buffer.from(
            'f0430101010000003c000000000000006500000000000000000000000000000000000000000000000000000000000000000000000000000000010000000704020003000004000000',
            'hex',
        ),
        defaultTotalSeconds: 60,
    },
    오븐: {
        inner: Buffer.from(
            'f04301010100000c0000b400000000006900000000000000000000000000000000000000000000000000000000000000000000000000000000010000010704020a04000004000000',
            'hex',
        ),
        defaultTotalSeconds: 20 * 60,
    },
    스팀: {
        inner: Buffer.from(
            'f04301010100000600006900000000006d00000000000000000000000000000000000000000000000000000000000000000000000000000000010000010704010804000004000000',
            'hex',
        ),
        defaultTotalSeconds: 10 * 60,
    },
    식품건조: {
        inner: Buffer.from(
            'f04301010100000100002800000000006e00000000000000000000000000000000000000000000000000000000000000000000000000000000010000010705020a04000004000000',
            'hex',
        ),
        defaultTotalSeconds: 100,
    },
    발효: {
        inner: Buffer.from(
            'f04301010100000028002800000000006f00000000000000000000000000000000000000000000000000000000000000000000000000000000010000010705020a04000004000000',
            'hex',
        ),
        defaultTotalSeconds: 40,
    },
}
const DEFAULT_COURSE = '구이'

function clampMinutes(n: number): number {
    if (!Number.isFinite(n)) return MIN_MINUTES
    return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(n)))
}

function clampSeconds(n: number): number {
    if (!Number.isFinite(n)) return 0
    const snapped = Math.round(n / SECOND_STEP) * SECOND_STEP
    return Math.min(MAX_SECONDS, Math.max(0, snapped))
}

function buildCourseFrame(courseName: string, totalSeconds: number): Buffer {
    const course = COURSES[courseName]
    const inner = Buffer.from(course.inner)
    inner[7] = Math.floor(totalSeconds / 100) & 0xff
    inner[8] = totalSeconds % 100
    return inner
}

function buildCancel(): Buffer {
    return Buffer.from([0xf0, 0x44, 0x00])
}

export default class Device extends AABBDevice {
    selectedCourse: string = DEFAULT_COURSE
    cookMinutes: number = Math.floor(COURSES[DEFAULT_COURSE].defaultTotalSeconds / 60)
    cookSeconds: number = COURSES[DEFAULT_COURSE].defaultTotalSeconds % 60

    private seenUnknown = new Set<string>()

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Oven' }),
            components: {
                course: {
                    platform: 'select',
                    unique_id: '$deviceid-course',
                    state_topic: '$this/course',
                    command_topic: '$this/course/set',
                    name: 'Course',
                    icon: 'mdi:stove',
                    options: Object.keys(COURSES),
                },
                cook_time_minutes: {
                    platform: 'number',
                    unique_id: '$deviceid-cook_time_minutes',
                    name: 'Cook time (minutes)',
                    icon: 'mdi:timer-outline',
                    min: MIN_MINUTES,
                    max: MAX_MINUTES,
                    step: 1,
                    mode: 'box',
                    state_topic: '$this/cook_time_minutes',
                    command_topic: '$this/cook_time_minutes/set',
                },
                cook_time_seconds: {
                    platform: 'number',
                    unique_id: '$deviceid-cook_time_seconds',
                    name: 'Cook time (seconds)',
                    icon: 'mdi:timer-outline',
                    min: 0,
                    max: MAX_SECONDS,
                    step: SECOND_STEP,
                    mode: 'box',
                    state_topic: '$this/cook_time_seconds',
                    command_topic: '$this/cook_time_seconds/set',
                },
                send: {
                    platform: 'button',
                    unique_id: '$deviceid-send',
                    command_topic: '$this/send/set',
                    name: 'Send to oven',
                    icon: 'mdi:send',
                },
                cancel: {
                    platform: 'button',
                    unique_id: '$deviceid-cancel',
                    command_topic: '$this/cancel/set',
                    name: 'Cancel',
                    icon: 'mdi:cancel',
                },
                current_status: {
                    platform: 'sensor',
                    unique_id: '$deviceid-current_status',
                    state_topic: '$this/current_status',
                    name: 'Status',
                    icon: 'mdi:information-outline',
                },
                oven_temperature: {
                    platform: 'sensor',
                    unique_id: '$deviceid-oven_temperature',
                    state_topic: '$this/oven_temperature',
                    name: 'Temperature',
                    icon: 'mdi:thermometer',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                },
            },
        })

        this.setConfig(config)
        this.publishProperty('course', this.selectedCourse)
        this.publishProperty('cook_time_minutes', this.cookMinutes)
        this.publishProperty('cook_time_seconds', this.cookSeconds)
        log(
            'status',
            this.id,
            'ML32PWFOTA (광파오븐) handler started - course select + cook time + send/cancel, never start; see file header',
        )
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'course': {
                if (!(mqttValue in COURSES)) {
                    console.warn(`ML32PWFOTA: unknown course "${mqttValue}"`)
                    return
                }
                this.selectedCourse = mqttValue
                // Switching course resets the time controls to that course's own UI default,
                // matching the real web UI's behaviour observed while capturing the course table.
                const def = COURSES[mqttValue].defaultTotalSeconds
                this.cookMinutes = Math.floor(def / 60)
                this.cookSeconds = def % 60
                this.publishProperty('course', mqttValue)
                this.publishProperty('cook_time_minutes', this.cookMinutes)
                this.publishProperty('cook_time_seconds', this.cookSeconds)
                return
            }
            case 'cook_time_minutes':
                this.cookMinutes = clampMinutes(Number(mqttValue))
                this.publishProperty('cook_time_minutes', this.cookMinutes)
                return
            case 'cook_time_seconds':
                this.cookSeconds = clampSeconds(Number(mqttValue))
                this.publishProperty('cook_time_seconds', this.cookSeconds)
                return
            case 'send': {
                const totalSeconds = this.cookMinutes * 60 + this.cookSeconds
                this.send(buildCourseFrame(this.selectedCourse, totalSeconds))
                return
            }
            case 'cancel':
                this.send(buildCancel())
                return
            default:
                console.warn(`ML32PWFOTA: attempting to set unknown property ${prop}`)
        }
    }

    processAABB(buf: Buffer) {
        // acks: <sub> 00 <opcode> 00  (4 bytes) - nothing to publish, just confirms the write landed
        if (
            buf.length === 4 &&
            buf[1] === 0x00 &&
            buf[3] === 0x00 &&
            (buf[2] === ACK_OPCODE_SEND || buf[2] === ACK_OPCODE_CANCEL)
        )
            return

        // `40 ec` state-echo: two 28-byte records (old, new) after the opcode - see file header's
        // STATE section. Only the second (current) record is published, the same convention
        // 2REF21EBNSX_3.ts uses for its own old/new state pairing.
        if (buf.length === 2 + 2 * STATE_RECORD_LEN && buf[0] === STATE_OPCODE_HI && buf[1] === STATE_OPCODE_LO) {
            const current = buf.subarray(2 + STATE_RECORD_LEN, 2 + 2 * STATE_RECORD_LEN)
            this.publishProperty('current_status', decodeStatus(current[0]))
            this.publishProperty('oven_temperature', current[6])
            return
        }

        // anything else is not decoded yet - see file header.
        const key = buf.length > 0 ? `${buf.length}:${buf[0].toString(16)}:${(buf[1] ?? 0).toString(16)}` : 'empty'
        if (!this.seenUnknown.has(key)) {
            this.seenUnknown.add(key)
            log('status', this.id, `ML32PWFOTA: unrecognised frame shape (len=${buf.length}, buf[0..1]=${key})`)
            recordNote(this.id, this.thinq.meta, 'unmodelled-aabb-frame', { len: buf.length, head: key })
        }
    }
}
