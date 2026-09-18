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
 *
 * POWER READ-BACK (decoded 2026-09-12, CORRECTED 2026-09-13 - see STATUS RECORD below): the
 * power-command echo above never got past one ambiguous capture and is still not read from. This
 * model's real status record - `buf[0..1] == 0x31 0x0a`, the MSG_TUNNEL envelope FX___S documents
 * (extended-length test, inner type `0xec`/`0xeb` at `payload[6]`, two 36-byte records back to
 * back for `0xec`, one alone for `0xeb`) - does carry it, once the record is extracted. The
 * original pass here read power from `record[2]`, cross-checking the LG cloud's own
 * `washerDryer.state` 4+ times and finding `record[2]`/`record[9]` moved together, `(0,0)` for
 * POWEROFF and `(4,1)` for INITIAL. That held up because every one of those repeats left the
 * appliance on its default course (강력 스타일링, id 4) the whole time - `record[2]` is actually
 * the *course id*, not power, and it only looked like a clean power pair because "off" resets it
 * to 0 and the only course ever active during that test happened to be id 4. The 2026-09-13 course
 * sweep below broke that coincidence (changing course changes `record[2]` while `power` stays put)
 * and found the real, course-independent power bit at `record[9]` alone (`0` off / `1` on) - see
 * STATUS RECORD.
 *
 * STATUS RECORD, FULL DECODE (2026-09-13): cracked open the same way H01.ts's dishwasher record
 * was the same day - selecting every named course in the app's picker in turn and reading back the
 * very next status record, then adjusting a time-adjustable course's duration up and down.
 *
 *   record[2]  - course id. Confirmed for every course below by name; unconfirmed ids read back
 *                as a bare number rather than guessed at.
 *   record[9]  - power: 0 = off, 1 = on. Resets to 0 (with `record[2]` also resetting to 0)
 *                whenever the appliance is off, independent of whatever course is selected -
 *                this is the byte the original pass above was actually (accidentally) reading.
 *   record[6]  - the course's expected duration in minutes (record[8] is an exact copy). Tracks
 *                live: for a fixed-duration course this is just that course's preset, but for a
 *                time-adjustable course (실내 제습/시간 건조) it reflects whatever duration was
 *                just dialled in, confirmed by watching 2시간→4시간 land here unchanged elsewhere.
 *   record[1]  - a step index used only by time-adjustable courses (0 for every fixed-duration
 *                course seen) - climbed 1,2,3,...,10 as 시간 건조's duration was clicked through
 *                30/40/.../180 minutes, and 8→11 for 실내 제습's 2h→4h. Not itself published (its
 *                information is redundant with `record[6]`'s actual minutes); noted here so a
 *                future session does not mistake it for a course-category field, which is what it
 *                looked like on first glance (see the retracted read further up for why that kind
 *                of coincidence is worth documenting even after it is ruled out).
 *
 * COURSE ID SWEEP, PART 2 (2026-09-13) - the ~31 ids the 2026-09-09 sweep in the file header above
 * could not attribute with confidence, now confirmed the same one-control-at-a-time way. Combined
 * with the original 10, this is every id seen against a real unit so far (all in `COURSES` below):
 *
 *   0x02 = 인공지능 스타일링 (29분, appliance shows no time - see hasFixedDuration below)
 *   0x03 = 급속 스타일링 (18분)              0x1F = 아기옷 살균 (64분)
 *   0x04 = 강력 스타일링 (53분, default)     0x25 = 인형 살균 (71분)
 *   0x05 = 정장/코트 스타일링 (31분)         0x2A = 청바지 스타일링 (71분)
 *   0x06 = 울/니트 스타일링 (26분)           0x0D = 셔츠 한 벌 건조 (39분)
 *   0x0E = 인공지능 건조 (내부값 90분, 화면엔 안 뜸)
 *   0x11 = 침구,베개 살균 (72분)             0x12 = 모피/가죽 스타일링 (35분)
 *   0x13 = 패딩 건조 (110분)                 0x14 = 패딩 스타일링 (48분)
 *   0x0F = 실내 제습 (시간 조절형, 2h/4h 확인 - record[1] 참고)
 *   0x17 = 시간 건조 (시간 조절형, 30분~3시간 - record[1] 참고)
 *
 * NOTIFICATION (decoded 2026-09-14): found the same way as 3REK2G03VI200S_2.ts's (kimchi fridge)
 * and ML32PWFOTA.ts's (oven) - cross-referencing the official `lg_thinq` integration's live
 * `event.seutailreo_notification` entity (`event_types: [styling_is_complete, error_has_occurred]`)
 * history against this device's own frame log. Same `<sub> 72 <payload>` convention those two
 * devices use (`sub = 0x31` here, matching this model's other from-device frames - see POWER
 * above), but NOT a fixed 15-byte frame like theirs - length varies with the payload:
 *
 *   styling_is_complete   31 72 00 00 00              (2 independent samples, 09-09 and 09-12,
 *                                                       each ~1.5-1.7s before the cloud event fired)
 *   error_has_occurred    31 72 00 64 03 00 00 00     (1 sample only, 09-09 11:38:27, ~1.6s before
 *                                                       the cloud event - code value 0x64/100 reads
 *                                                       like a generic "an error happened" bucket,
 *                                                       but with only one capture this is tentative,
 *                                                       same confidence tier as MI2D7B's
 *                                                       remaining_minutes)
 *
 * `buf[2]` is 0 in both (the same gate byte the other two devices use) and the code lives at
 * `buf[3]` same as them, so `NOTIFY_CODE_OFFSET` is shared - only the fixed frame-length check is
 * dropped here since this model's frames aren't a constant size.
 *
 * The `event.seutailreo_error` entity's *specific* fault (`need_water_replenishment`, fired
 * 2026-09-09 11:38:59.953 - 31s after the error_has_occurred sample above) did NOT correlate with
 * any `0x72`-shaped frame nearby, only the regular EC status record. Diffing that record against
 * an unrelated normal sample (different course/duration, so most bytes differ for unrelated
 * reasons) could not isolate a specific flag byte - unresolved, needs a live one-variable-at-a-time
 * reproduction (or another real fault) to pin down, the same way the regular fridge's per-fault
 * codes remain unresolved.
 *
 * SMART CARE - FINE DUST (captured 2026-09-18): the app's 설정 -> 스마트케어 screen ("미세먼지
 * 맞춤" - runs the moving hanger harder when today's fine dust/PM2.5 reading is "매우 나쁨" or
 * worse), cloud capability `stylerSmartCareFineDust.setSmartCareFineDust`. Same F0E5 opcode family
 * as everything else in this file, a key not seen anywhere else in this file's own captures or
 * FX___S's/RD20_S's vocabulary:
 *
 *   to-device   aa 0d f0 e5 00 02 01 ff 01 1c 01 <ck> bb   (on)
 *   to-device   aa 0d f0 e5 00 02 01 ff 01 1c 00 <ck> bb   (off)
 *   from-device aa 08 31 00 e5 00 <ck> bb                 (ack both times, same shape as power's)
 *
 * Both directions captured directly (toggled on, then off again to restore the appliance's prior
 * setting). Published optimistically, matching `power` - the appliance was not run through a full
 * fine-dust-triggered cycle to look for a live readback bit, and this being a "today's weather"
 * condition rather than a discrete state change makes one hard to isolate cleanly even if there is
 * one, the same reasoning FX___S.ts's own drum_light_auto capture gives for not chasing it either.
 *
 * SMART CARE - HUMIDITY (captured 2026-09-18, same pass as FINE DUST above): "습도 맞춤" (extends
 * the drying time on humid days), cloud capability `stylerSmartCareHumidity.setSmartCareHumidity`.
 * Same opcode, key 0x1b - a coincidental reuse of RD20_S.ts's/FX___S.ts's own KEY_DRUM_LIGHT_AUTO
 * key number for a completely unrelated setting on this model; this protocol's key numbering is
 * evidently assigned per model firmware, not from one shared global namespace, so the same byte
 * value meaning different things on different models is expected rather than a bug to chase:
 *
 *   to-device   aa 0d f0 e5 00 02 01 ff 01 1b 01 <ck> bb   (on)
 *   to-device   aa 0d f0 e5 00 02 01 ff 01 1b 00 <ck> bb   (off)
 *
 * Both directions captured directly (toggled on, then off again). Optimistic, same reasoning as
 * FINE DUST above.
 *
 * SMART CARE - NIGHT CARE ON/OFF (captured 2026-09-18, same pass): "조용히" - if a course runs
 * within a set overnight window (default 오후 10:00-오전 6:00), the moving hanger works weaker so
 * it doesn't disturb sleep, at some cost to dust-removal performance (per the screen's own warning
 * text) - cloud capability `stylerSmartCareNightCare.setSmartCareNightCare` (the
 * on/off master switch only; that capability's other two commands, `setStartTime`/`setEndTime`,
 * set the window itself via a time-picker sub-screen and are NOT captured here):
 *
 *   to-device   aa 0d f0 e5 00 02 01 ff 01 1a 01 <ck> bb   (on)
 *   to-device   aa 0d f0 e5 00 02 01 ff 01 1a 00 <ck> bb   (off)
 *
 * Both directions captured directly (toggled on, then off again). Optimistic, same reasoning as
 * FINE DUST/HUMIDITY above. Note this is a THIRD key in the 0x1a-0x1c range on this one model
 * alone (0x1a night-care, 0x1b humidity, 0x1c fine-dust) - apparently sequential allocation within
 * this firmware's own smart-care feature set, distinct from the coincidental 0x1b clash with
 * RD20_S/FX___S's unrelated KEY_DRUM_LIGHT_AUTO noted above.
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
/** See the file header's SMART CARE - FINE DUST section. */
const KEY_SMART_CARE_FINE_DUST = 0x1c
/** See the file header's SMART CARE - HUMIDITY section. */
const KEY_SMART_CARE_HUMIDITY = 0x1b
/** See the file header's SMART CARE - NIGHT CARE ON/OFF section. */
const KEY_SMART_CARE_NIGHT_CARE = 0x1a

/** See the file header's STATUS RECORD section - the MSG_TUNNEL envelope FX___S.ts documents,
 *  reused here just for the record split (this handler does not otherwise parse the record). */
const MSG_TUNNEL = 0x0a
const INNER_STATE = 0xec
const INNER_STATE_SINGLE = 0xeb
const RECORD_LEN = 36
const REC_COURSE_ID = 2
const REC_POWER = 9
const REC_DURATION_MINUTES = 6

/** See the file header's NOTIFICATION section. Unlike 3REK2G03VI200S_2.ts/ML32PWFOTA.ts, frame
 *  length is NOT fixed here, so there is no NOTIFY_FRAME_LEN to check. */
const NOTIFY_SUB = 0x31
const NOTIFY_OPCODE = 0x72
const NOTIFY_CODE_OFFSET = 3
const NOTIFICATION: Record<number, string> = {
    0: 'styling_is_complete',
    // Tentative - only 1 sample so far, see the file header.
    0x64: 'error_has_occurred',
}
const NOTIFICATION_OPTIONS = [...new Set(Object.values(NOTIFICATION))]

/** Every course id confirmed against a real unit so far; see the file header's two COURSE ID
 *  SWEEP sections. */
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
    '정장/코트 스타일링': 0x05,
    '울/니트 스타일링': 0x06,
    '셔츠 한 벌 건조': 0x0d,
    '인공지능 건조': 0x0e,
    '침구,베개 살균': 0x11,
    '모피/가죽 스타일링': 0x12,
    '패딩 건조': 0x13,
    '패딩 스타일링': 0x14,
    '실내 제습': 0x0f,
    '시간 건조': 0x17,
    '아기옷 살균': 0x1f,
    '인형 살균': 0x25,
    '청바지 스타일링': 0x2a,
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
            ...HADevice.config(meta),
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
                // Read-only: what the appliance's own panel is actually showing right now, which
                // may not match the `course` select above (that one is only "what a future Start
                // press will use", set either by us or by this same read - see processAABB).
                active_course: {
                    platform: 'sensor',
                    unique_id: '$deviceid-active_course',
                    state_topic: '$this/active_course',
                    name: 'Active course',
                    icon: 'mdi:tshirt-crew-outline',
                    entity_category: 'diagnostic',
                },
                duration_minutes: {
                    platform: 'sensor',
                    unique_id: '$deviceid-duration_minutes',
                    state_topic: '$this/duration_minutes',
                    name: 'Course duration',
                    icon: 'mdi:timer-outline',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                },
                // See the file header's NOTIFICATION section.
                notification: {
                    platform: 'event',
                    unique_id: '$deviceid-notification',
                    state_topic: '$this/notification',
                    event_types: NOTIFICATION_OPTIONS,
                    name: 'Notification',
                    icon: 'mdi:bell-ring-outline',
                },
                // See the file header's SMART CARE - FINE DUST section.
                smart_care_fine_dust: {
                    platform: 'switch',
                    unique_id: '$deviceid-smart_care_fine_dust',
                    state_topic: '$this/smart_care_fine_dust',
                    command_topic: '$this/smart_care_fine_dust/set',
                    name: 'Smart care - fine dust',
                    icon: 'mdi:weather-hazy',
                    entity_category: 'config',
                },
                // See the file header's SMART CARE - HUMIDITY section.
                smart_care_humidity: {
                    platform: 'switch',
                    unique_id: '$deviceid-smart_care_humidity',
                    state_topic: '$this/smart_care_humidity',
                    command_topic: '$this/smart_care_humidity/set',
                    name: 'Smart care - humidity',
                    icon: 'mdi:water-percent',
                    entity_category: 'config',
                },
                // See the file header's SMART CARE - NIGHT CARE ON/OFF section. The window itself
                // (default 오후 10:00-오전 6:00) is not adjustable here - only this master switch.
                smart_care_night_care: {
                    platform: 'switch',
                    unique_id: '$deviceid-smart_care_night_care',
                    state_topic: '$this/smart_care_night_care',
                    command_topic: '$this/smart_care_night_care/set',
                    name: 'Smart care - night care',
                    icon: 'mdi:weather-night',
                    entity_category: 'config',
                },
            },
        })

        this.setConfig(config)
        this.publishProperty('course', COURSE_BY_ID[this.selectedCourse])
        log(
            'status',
            this.id,
            'ST_R_ETH01Y_ (스타일러) handler started - power, course select, start, smart care fine dust/humidity/night care; see file header',
        )
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
            case 'smart_care_fine_dust': {
                const on = mqttValue === 'ON'
                this.send(buildSettingsWrite([[KEY_SMART_CARE_FINE_DUST, on ? 1 : 0]]))
                // Optimistic - see the file header's SMART CARE - FINE DUST section.
                this.publishProperty('smart_care_fine_dust', on ? 'ON' : 'OFF')
                return
            }
            case 'smart_care_humidity': {
                const on = mqttValue === 'ON'
                this.send(buildSettingsWrite([[KEY_SMART_CARE_HUMIDITY, on ? 1 : 0]]))
                // Optimistic - see the file header's SMART CARE - HUMIDITY section.
                this.publishProperty('smart_care_humidity', on ? 'ON' : 'OFF')
                return
            }
            case 'smart_care_night_care': {
                const on = mqttValue === 'ON'
                this.send(buildSettingsWrite([[KEY_SMART_CARE_NIGHT_CARE, on ? 1 : 0]]))
                // Optimistic - see the file header's SMART CARE - NIGHT CARE ON/OFF section.
                this.publishProperty('smart_care_night_care', on ? 'ON' : 'OFF')
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

    /** Events do not go through publishProperty - not deduped (a repeat of the same event must
     *  still fire) and not retained (an event entity should not replay a stale past occurrence at
     *  every reconnect) - see FX___S.ts's identical method for the full reasoning. */
    publishEvent(topic: string, eventType: string) {
        this.HA.publishProperty(this.id, topic, JSON.stringify({ event_type: eventType }), { retain: false })
    }

    processAABB(buf: Buffer) {
        // ack: <sub> 00 e5 00  (4 bytes) - nothing to publish, just confirms the write landed
        if (buf.length === 4 && buf[1] === 0x00 && buf[2] === FROM_DEVICE_ACK_OPCODE && buf[3] === 0x00) return

        // notification channel: <sub=0x31> 72 <payload> - see the file header's NOTIFICATION
        // section. Frame length is not fixed here (unlike the other two devices using this
        // convention), so only the sub/opcode/gate byte are checked.
        if (buf[0] === NOTIFY_SUB && buf[1] === NOTIFY_OPCODE && buf.length > NOTIFY_CODE_OFFSET && buf[2] === 0) {
            const name = NOTIFICATION[buf[NOTIFY_CODE_OFFSET]]
            if (name !== undefined) this.publishEvent('notification', name)
            return
        }

        // Status record - see file header's STATUS RECORD section.
        if (buf[1] === MSG_TUNNEL) {
            const extended = buf.readUInt16BE(2) === buf.length + 4
            const payload = extended ? buf.subarray(4) : buf.subarray(2)
            if (payload.length > 6) {
                const data = payload.subarray(10)
                const offset = payload[6] === INNER_STATE ? RECORD_LEN : payload[6] === INNER_STATE_SINGLE ? 0 : -1
                if (offset >= 0 && data.length >= offset + RECORD_LEN) {
                    const record = data.subarray(offset, offset + RECORD_LEN)

                    const on = record[REC_POWER] !== 0
                    if (on !== this.power) {
                        this.power = on
                        this.publishProperty('power', on ? 'ON' : 'OFF')
                    }

                    // record[REC_COURSE_ID] resets to 0 (not a real course id) while off - see
                    // file header's STATUS RECORD section - so only trust it while on.
                    if (on) {
                        const courseId = record[REC_COURSE_ID]
                        this.publishProperty('active_course', COURSE_BY_ID[courseId] ?? `unknown_${courseId}`)
                        this.publishProperty('duration_minutes', record[REC_DURATION_MINUTES])
                    }
                    return
                }
            }
        }

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
