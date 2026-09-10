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
 * seconds splits as `inner[7] = totalSeconds // 100`, `inner[8] = totalSeconds % 100`. Only
 * directly confirmed up to 21:05 (1265s) - see MIN/MAX SECONDS below for why the multi-hour
 * courses are not fully trusted against this formula yet.
 *
 * MIN/MAX SECONDS (reported directly by the user from the appliance's own UI, 2026-09-10, not an
 * independent capture): 구이 10s-50min, 레인지 10s-90min, 오븐 0s-90min (0s is a real, meaningful
 * value here - "0초로 켜면 예열만 됨", setting 0 just preheats rather than being invalid), 스팀
 * 10s-30min, 식품건조 and 발효 both 5min-9h. The steam-combo variants (스팀레인지/스팀오븐/
 * 스팀발효 - see ACTIVE COURSE below) share their base course's range. `COURSES` below enforces
 * these as the real min/max for each course's `cook_time_minutes`/`cook_time_seconds` controls.
 *
 * Sending is capped to whatever `inner[7]/inner[8]` can hold as a single byte quotient (about
 * 7h06m - see `MAX_ENCODABLE_SECONDS`), which is short of 식품건조/발효's real 9-hour maximum -
 * and more importantly, the quotient/remainder-of-100 write formula itself was only confirmed up
 * to 21 minutes. Extending it to multi-hour values is an untested extrapolation: the read side
 * uses a completely different, display-friendly H:M:S split for long courses (see ACTIVE COURSE
 * below), so it is plausible the write side does too, in which case a long 식품건조/발효 send
 * would silently encode the wrong duration. Not verified either way yet - a real multi-hour send,
 * checked against the appliance's own displayed countdown, would settle it.
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
 *                temp-less 레인지 send. See NO_TEMPERATURE_COURSE_IDS for the full per-course
 *                breakdown of which ones are genuinely temp-less (always 0) vs. which carry a
 *                real value - oven_temperature is suppressed rather than published as a misleading
 *                0.0°C for the former.
 *   record[7]  = `0x04` whenever status is "preference" (even for 레인지's temp=0 case, so this
 *                is not a "has a temperature" flag), `0x00` whenever "initial".
 *   record[8]  = `0x01` only in the idle/"initial" record, `0x00` otherwise - the mirror image of
 *                record[0], reproduced literally since nothing yet explains why the appliance
 *                repeats the idle/non-idle distinction at two separate offsets.
 *   record[2..5,9..27] = `0x00` in every capture so far.
 *
 * REAL COOKS (2026-09-10): the user physically started several real runs at the appliance itself
 * (course queued remotely first, then started with a physical button press - this handler still
 * never sends a start command, see above), giving three more confirmed status values, again
 * matching the official sensor's own strings exactly:
 *
 *   0x02 = "cooking_in_progress"   0x04 = "paused"   0x05 = "done"
 *
 * The first was a single 10-second 레인지 run left to finish on its own: record[1] was `0x01`
 * (not "preference"'s usual `0x13`) right before it started and stayed `0x01` into
 * "cooking_in_progress", dropping to `0x00` at "done". record[5] read `0x0a` (10) during
 * "cooking_in_progress", matching the course's 10-second length. "done" persisted for about 80
 * seconds (matching the appliance's own completion chime/display) before falling back to
 * "initial" on its own - no user action was needed to clear it.
 *
 * A later, much larger session (~10 minutes, roughly a dozen separate real runs across 오븐/
 * 레인지/스팀-combo modes, several deliberately stopped mid-run with the physical Stop button)
 * confirmed "paused" and strengthened the record[5] countdown reading, and strongly suggested
 * record[1] was a per-course identifier - but matching specific values to specific courses from
 * that session's frame log and official-sensor timestamps alone wasn't done with full confidence.
 *
 * ACTIVE COURSE AND REMAINING TIME - fully confirmed 2026-09-10 in a dedicated, one-course-at-a-
 * time follow-up session: the user started each of the 6 courses (plus the 3 steam-combo variants
 * the mode picker also offers - 스팀레인지/스팀오븐/스팀발효) for real, reporting the exact
 * course and start/stop time live, immediately checked against the frame log:
 *
 *   record[1]  1 = 레인지        2 = 스팀레인지     3 = 구이
 *              4 = 오븐          5 = 스팀오븐       6 = 스팀(찜)
 *              7 = 식품건조     21 = 발효          22 = 스팀발효
 *
 * 식품건조 and 발효 write byte-for-byte identical course-selector bytes (see COURSE TABLE below)
 * but the appliance clearly tells them apart internally - record[1] is 7 for one and 21 for the
 * other, confirmed live both times.
 *
 * The remaining-time field turned out to be a full H:M:S split, not just seconds - the short test
 * runs earlier only ever showed the seconds place because their courses were under a minute:
 *
 *   record[3] = hours remaining   record[4] = minutes remaining   record[5] = seconds remaining
 *
 * Confirmed at every scale the picker offers, from a 10-second 레인지 run up to a 9-hour 스팀발효
 * run (started at 9:00:00, stopped at 8:59:56 - the UI's own countdown display drops the seconds
 * digit entirely past a few minutes, but the appliance keeps reporting it underneath). `active_course`
 * and `remaining_time` (total seconds, `record[3]*3600 + record[4]*60 + record[5]`) below are only
 * published while `current_status` is "cooking_in_progress" or "paused" - record[1] reads a
 * different, non-course value while queued ("preference", always `0x13` regardless of which course)
 * or during a maintenance run ("cleaning", a constant `0x12` confirmed across all 5 maintenance
 * functions - see ACTIVE CLEANING FUNCTION below), so publishing it as a course name in those
 * states would be wrong or meaningless.
 *
 * ACTIVE CLEANING FUNCTION: the user also ran all 5 of the appliance's own maintenance functions
 * (스팀청소탈취/스팀발생기세정/잔수제거/조리실건조/스팀청소 - all under the physical panel's own
 * cleaning menu, not anything this handler can trigger), one at a time, live - each produced the
 * exact same preference -> `0x03` -> (`0x04`, if stopped early) -> initial shape as a cooking run,
 * and the official sensor named `0x03` "cleaning" every time - added to STATUS_NAMES below.
 * record[1] read the same `0x12` for every one of them, so it is *not* a per-function id while
 * cleaning the way it is a per-course id while cooking - instead record[2] (always `0x00` while
 * actually cooking, see below) carries the cleaning-function id, confirmed one function at a time
 * against each function's own reported default duration and a live stop time. record[4]/record[5]
 * still read minutes/seconds remaining as normal, but record[3] (hours while cooking) stays `0x00`
 * here too - none of the 5 functions run long enough to need it:
 *
 *   record[2]  1 = 스팀청소탈취(deodorize)   2 = 스팀청소        3 = 조리실건조
 *              4 = 잔수제거                 5 = 스팀발생기세정
 *
 * A separate `active_cleaning_function` property (its own decode map, `CLEANING_FUNCTION_NAMES` -
 * reusing `decodeCourseId`'s numbering would be wrong, since 3 collides with 구이 there) reads
 * record[2] specifically while `current_status` is "cleaning" or "paused" during one.
 *
 * `current_status` below passes through any other status byte as a plain `unknown_<n>` string
 * rather than guessing a name for it - a real fault mid-cook is still unconfirmed.
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
 * bakes in whatever the UI's own default was, not independently controllable here. The steam-combo
 * variants (스팀레인지/스팀오븐/스팀발효) - these are a "스팀 추가" checkbox layered on top of
 * 레인지/오븐/발효 in the UI, not separate picker entries, and no capture isolated which byte that
 * checkbox flips - so `COURSES` only offers the 6 base modes; the combo record[1] values are
 * decoded for reading but this handler cannot send them. Whether sending a
 * multi-hour 식품건조/발효 duration actually reaches the appliance correctly (see MIN/MAX SECONDS
 * above). The `40 bf` and `40 72` frames that appeared alongside real cooks and maintenance runs
 * (something event/notification-shaped, given the timing) - not decoded at all (`40 eb`, a
 * similarly-shaped frame this handler used to leave unmodelled too, turned out to be a plain
 * periodic heartbeat carrying the same 28-byte record as `40 ec`'s current half - see
 * QUERY_OPCODE_LO - but `40 bf`/`40 72` are a different shape and remain unexplained). A real fault
 * mid-cook. Whether the oven itself reports its own door open/closed the way the fridge does. Also
 * 스팀 mode pops a "물통을 채워주세요" (fill the water tank) confirm dialog in the UI before it
 * will send - not reproduced or needed here since this handler only ever queues a course, never
 * starts one.
 *
 * CONFIRMED NOT NETWORKED: 잠금 설정 (control lock) - the user engaged and released it directly
 * on the physical panel (no representation in the official app either) and no distinctive frame
 * appeared either time - it is a local-only, physical-panel feature with nothing to decode here.
 */

const ACK_OPCODE_SEND = 0x43
const ACK_OPCODE_CANCEL = 0x44
const STATE_OPCODE_HI = 0x40
const STATE_OPCODE_LO = 0xec
/** The periodic single-record heartbeat sibling of `40 ec` - see processAABB's `40 eb` branch. */
const QUERY_OPCODE_LO = 0xeb
const STATE_RECORD_LEN = 28

/** record[0] values confirmed against the official lg_thinq integration's own status strings -
 *  see the file header's STATE section. Anything else is passed through as `unknown_<n>`. */
const STATUS_NAMES: Record<number, string> = {
    0x00: 'initial',
    0x07: 'preference',
    0x02: 'cooking_in_progress',
    0x03: 'cleaning',
    0x04: 'paused',
    0x05: 'done',
    0x01: 'preheating',
    0x06: 'preheating_is_done',
}
function decodeStatus(b: number): string {
    return STATUS_NAMES[b] ?? `unknown_${b}`
}

/** record[1] values confirmed live, one course at a time, against the frame log - see the file
 *  header's ACTIVE COURSE AND REMAINING TIME section. Only meaningful while record[0] is
 *  "cooking_in_progress" or "paused" - it reads a different, non-course value while queued or
 *  cleaning. */
const COURSE_ID_NAMES: Record<number, string> = {
    1: '레인지',
    2: '스팀레인지',
    3: '구이',
    4: '오븐',
    5: '스팀오븐',
    6: '스팀',
    7: '식품건조',
    21: '발효',
    22: '스팀발효',
}

/** record[1] ids of courses confirmed live (2026-09-10, a full day's captures across every real
 *  run of each) to never carry a target temperature - record[6] read a constant 0 in all of them,
 *  every time, regardless of what was cooking. The rest of COURSE_ID_NAMES's ids (오븐 100-230,
 *  스팀오븐 180-230, 식품건조 40/70, 발효/스팀발효 40) do carry a real one. Used to suppress
 *  oven_temperature for these rather than publishing a misleading "0.0°C" for a course that has no
 *  temperature concept at all. */
const NO_TEMPERATURE_COURSE_IDS = new Set([1, 2, 3, 6]) // 레인지, 스팀레인지, 구이, 스팀
/** Any record[1] outside the manual-course table above belongs to one of the appliance's ~30
 *  built-in "자동요리"(auto cook) recipes - id 8, 20, ... each holding its own recipe number in
 *  record[2] (confirmed live for 감자삶기=8/1 and 냉동밥데우기 1인분=8/3, 2인분=20/193). There are
 *  too many to enumerate one by one (user's call), so every one of these is reported simply as
 *  "자동요리". MY_RECIPE_MARKER (below) is the one exception - it gets its own handling. */
function decodeCourseId(b: number): string {
    return COURSE_ID_NAMES[b] ?? '자동요리'
}

/** record[1] reads this constant, instead of either a real course id or an auto-cook recipe id,
 *  whenever this handler's own remote sends actually run: LG's firmware apparently records/
 *  replays any externally-sent course through a saved custom-recipe slot rather than as a plain
 *  manual course - confirmed live 2026-09-10, persisting through queued/cooking/paused, and
 *  confirmed on the appliance's own physical display as "내가 만든 레시피"(a recipe I made). It's
 *  reported as its own bucket, separate from the generic "자동요리" catch-all, matching that exact
 *  on-screen wording so it reads the same on the appliance and in HA. record[7] (always 0 in
 *  every other case seen so far) reads `4` here - initially suspected to be the underlying real
 *  course surviving somewhere, but disproven live: it stayed `4` across three remote sends whose
 *  HA course selector was 오븐, then 레인지, then 구이 - so it does NOT track the actual
 *  selection, it's something else (or just stuck), and isn't used for naming. */
const MY_RECIPE_MARKER = 0x13

/** record[1] reads this constant value (not a course id) for every one of the 5 maintenance
 *  functions, while "cleaning" or paused mid-cleaning - see the file header's ACTIVE CLEANING
 *  FUNCTION section. It never collides with a real course id (1-22, none of them 18). */
const CLEANING_MARKER = 0x12

/** record[2] values confirmed live, one cleaning function at a time - see the file header's
 *  ACTIVE CLEANING FUNCTION section. Only meaningful when record[1] === CLEANING_MARKER. */
const CLEANING_FUNCTION_NAMES: Record<number, string> = {
    1: '스팀청소탈취',
    2: '스팀청소',
    3: '조리실건조',
    4: '잔수제거',
    5: '스팀발생기세정',
}
function decodeCleaningFunction(b: number): string {
    return CLEANING_FUNCTION_NAMES[b] ?? `unknown_${b}`
}

const SECOND_STEP = 5
/** The widest range any course allows (식품건조/발효's 9 hours) - the static HA slider bound for
 *  cook_time_minutes. The real, tighter per-course bound is enforced in code - see COURSES. */
const MAX_POSSIBLE_MINUTES = 9 * 60

/** Each entry's `inner` is the exact 72-byte buffer captured for that course's own UI default -
 *  see the file header's COURSE TABLE - except the time bytes, which `buildCourseFrame` always
 *  overwrites from `cookMinutes`/`cookSeconds` at send time, so `inner`'s own baked-in time value
 *  is never actually sent. `defaultTotalSeconds` is only used to reset the time controls when the
 *  user switches course, matching the real web UI resetting its own time picker - it is the `기본`
 *  (default) the user reported directly from the appliance's own UI (2026-09-10), which for 오븐/
 *  식품건조/발효 differs from what this handler's very first captures happened to show (20분/1분
 *  40초/40초 respectively - most likely just whatever those screens were last left at during
 *  capture, not the appliance's real factory default). `minSeconds`/`maxSeconds` are the real
 *  range the user reported for each course (오븐's own default note - "0초로 켜면 예열만 됨",
 *  0 seconds just preheats - is why its minimum is 0 while every other course's is 10s+). The
 *  steam-combo variants (스팀레인지/스팀오븐/스팀발효) share their base course's range but are
 *  not separately listed here - see NOT-YET-DECODED, this handler cannot send them yet. */
const COURSES: Record<
    string,
    {
        inner: Buffer
        defaultTotalSeconds: number
        minSeconds: number
        maxSeconds: number
        // Only present for a course that actually has an adjustable target temperature - see
        // NO_TEMPERATURE_COURSE_IDS and TEMP_MIN_POSSIBLE/TEMP_MAX_POSSIBLE below. Confirmed by
        // the user directly from the appliance's own UI, 2026-09-10: 오븐 100-230°C, 식품건조
        // 40-90°C. Absent for every other course here (구이/레인지/스팀/발효) - none of these had a
        // temperature range given, so inner[10]'s captured default is sent as-is, never overridden.
        minTemp?: number
        maxTemp?: number
        defaultTemp?: number
    }
> = {
    구이: {
        inner: Buffer.from(
            'f04301010100000c0000e600000000006600000000000000000000000000000000000000000000000000000000000000000000000000000000010000040704020a01000004000000',
            'hex',
        ),
        defaultTotalSeconds: 20 * 60,
        minSeconds: 10,
        maxSeconds: 50 * 60,
    },
    레인지: {
        inner: Buffer.from(
            'f0430101010000003c000000000000006500000000000000000000000000000000000000000000000000000000000000000000000000000000010000000704020003000004000000',
            'hex',
        ),
        defaultTotalSeconds: 60,
        minSeconds: 10,
        maxSeconds: 90 * 60,
    },
    오븐: {
        inner: Buffer.from(
            'f04301010100000c0000b400000000006900000000000000000000000000000000000000000000000000000000000000000000000000000000010000010704020a04000004000000',
            'hex',
        ),
        defaultTotalSeconds: 0,
        minSeconds: 0,
        maxSeconds: 90 * 60,
        minTemp: 100,
        maxTemp: 230,
        defaultTemp: 180, // matches inner[10]'s own captured default (0xb4)
    },
    스팀: {
        inner: Buffer.from(
            'f04301010100000600006900000000006d00000000000000000000000000000000000000000000000000000000000000000000000000000000010000010704010804000004000000',
            'hex',
        ),
        defaultTotalSeconds: 10 * 60,
        minSeconds: 10,
        maxSeconds: 30 * 60,
    },
    식품건조: {
        inner: Buffer.from(
            'f04301010100000100002800000000006e00000000000000000000000000000000000000000000000000000000000000000000000000000000010000010705020a04000004000000',
            'hex',
        ),
        defaultTotalSeconds: 6 * 3600,
        minSeconds: 5 * 60,
        maxSeconds: 9 * 3600,
        minTemp: 40,
        maxTemp: 90,
        defaultTemp: 40, // matches inner[10]'s own captured default (0x28)
    },
    발효: {
        inner: Buffer.from(
            'f04301010100000028002800000000006f00000000000000000000000000000000000000000000000000000000000000000000000000000000010000010705020a04000004000000',
            'hex',
        ),
        defaultTotalSeconds: 30 * 60,
        minSeconds: 5 * 60,
        maxSeconds: 9 * 3600,
    },
}
const DEFAULT_COURSE = '구이'

/** The widest range any temperature-adjustable course allows (오븐/식품건조's 100-230/40-90) - the
 *  static HA slider bound for target_temperature, the same pattern MAX_POSSIBLE_MINUTES uses for
 *  cook_time_minutes. The real, tighter per-course bound (or "not applicable at all" for a course
 *  with no minTemp/maxTemp) is enforced in code - see setCookTemp/buildCourseFrame. */
const TEMP_MIN_POSSIBLE = 0
const TEMP_MAX_POSSIBLE = 230

/** Clamps a requested target temperature to the selected course's own real range. Courses with no
 *  minTemp/maxTemp (구이/레인지/스팀/발효) don't have an adjustable temperature at all - clamping
 *  always returns 0 for these, and buildCourseFrame never writes it into the outgoing frame. */
function clampTemp(courseName: string, requestedTemp: number): number {
    const course = COURSES[courseName]
    if (course.minTemp === undefined || course.maxTemp === undefined) return 0
    if (!Number.isFinite(requestedTemp)) return course.minTemp
    return Math.min(course.maxTemp, Math.max(course.minTemp, Math.round(requestedTemp)))
}

/** Clamps a requested total-seconds value to the selected course's own real range, then snaps to
 *  the confirmed 5-second step. */
function clampTotalSeconds(courseName: string, totalSeconds: number): number {
    const { minSeconds, maxSeconds } = COURSES[courseName]
    if (!Number.isFinite(totalSeconds)) return minSeconds
    const snapped = Math.round(totalSeconds / SECOND_STEP) * SECOND_STEP
    return Math.min(maxSeconds, Math.max(minSeconds, snapped))
}

/** The largest total-seconds value `inner[7] = totalSeconds // 100` can hold in one byte -
 *  255*100+99. This formula was only directly confirmed against 구이 runs up to 21:05 (1265s);
 *  extrapolating it up to this ceiling is unverified for 식품건조/발효's multi-hour range - see
 *  the file header's MIN/MAX SECONDS note. */
const MAX_ENCODABLE_SECONDS = 255 * 100 + 99

function buildCourseFrame(courseName: string, totalSeconds: number, targetTemp: number): Buffer {
    const course = COURSES[courseName]
    const inner = Buffer.from(course.inner)
    const encodable = Math.min(totalSeconds, MAX_ENCODABLE_SECONDS)
    inner[7] = Math.floor(encodable / 100) & 0xff
    inner[8] = encodable % 100
    // Only overridden for a course with a real adjustable range (see COURSES/clampTemp) - every
    // other course keeps its captured template's own inner[10], unmodified. UNVERIFIED: this write
    // offset was identified from the file header's inner[10] note, but sending a non-default
    // temperature has not yet been confirmed live against a real 오븐/식품건조 run the way the
    // time offsets were - check the appliance's own display after a send before trusting it.
    if (course.minTemp !== undefined && course.maxTemp !== undefined) {
        inner[10] = clampTemp(courseName, targetTemp)
    }
    return inner
}

function buildCancel(): Buffer {
    return Buffer.from([0xf0, 0x44, 0x00])
}

export default class Device extends AABBDevice {
    selectedCourse: string = DEFAULT_COURSE
    cookMinutes: number = Math.floor(COURSES[DEFAULT_COURSE].defaultTotalSeconds / 60)
    cookSeconds: number = COURSES[DEFAULT_COURSE].defaultTotalSeconds % 60
    cookTemp: number = COURSES[DEFAULT_COURSE].defaultTemp ?? 0

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
                    min: 0,
                    max: MAX_POSSIBLE_MINUTES,
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
                    max: 55,
                    step: SECOND_STEP,
                    mode: 'box',
                    state_topic: '$this/cook_time_seconds',
                    command_topic: '$this/cook_time_seconds/set',
                },
                target_temperature: {
                    platform: 'number',
                    unique_id: '$deviceid-target_temperature',
                    name: 'Target temperature',
                    icon: 'mdi:thermometer',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    min: TEMP_MIN_POSSIBLE,
                    max: TEMP_MAX_POSSIBLE,
                    step: 1,
                    mode: 'box',
                    state_topic: '$this/target_temperature',
                    command_topic: '$this/target_temperature/set',
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
                active_course: {
                    platform: 'sensor',
                    unique_id: '$deviceid-active_course',
                    state_topic: '$this/active_course',
                    name: 'Active course',
                    icon: 'mdi:stove',
                },
                active_cleaning_function: {
                    platform: 'sensor',
                    unique_id: '$deviceid-active_cleaning_function',
                    state_topic: '$this/active_cleaning_function',
                    name: 'Active cleaning function',
                    icon: 'mdi:spray-bottle',
                },
                remaining_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining_time',
                    state_topic: '$this/remaining_time',
                    name: 'Remaining time',
                    icon: 'mdi:timer-outline',
                    device_class: 'duration',
                    unit_of_measurement: 's',
                },
            },
        })

        this.setConfig(config)
        this.publishProperty('course', this.selectedCourse)
        this.publishProperty('cook_time_minutes', this.cookMinutes)
        this.publishProperty('cook_time_seconds', this.cookSeconds)
        this.publishProperty('target_temperature', this.cookTemp)
        log(
            'status',
            this.id,
            'ML32PWFOTA (광파오븐) handler started - course select + cook time + send/cancel, never start; see file header',
        )
    }

    /** Clamps to the selected course's own real range (see COURSES) and publishes both controls -
     *  a change to either one is expressed as a new total, then split back into minutes/seconds,
     *  since clamping against the course's max/min can move both (e.g. hitting 구이's 50-minute
     *  ceiling zeroes the seconds field too). */
    private setCookTime(requestedTotalSeconds: number) {
        const clamped = clampTotalSeconds(this.selectedCourse, requestedTotalSeconds)
        this.cookMinutes = Math.floor(clamped / 60)
        this.cookSeconds = clamped % 60
        this.publishProperty('cook_time_minutes', this.cookMinutes)
        this.publishProperty('cook_time_seconds', this.cookSeconds)
    }

    /** Clamps to the selected course's own real range (see COURSES/clampTemp) - always 0 for a
     *  course with no adjustable temperature, same as buildCourseFrame's own handling. */
    private setCookTemp(requestedTemp: number) {
        this.cookTemp = clampTemp(this.selectedCourse, requestedTemp)
        this.publishProperty('target_temperature', this.cookTemp)
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'course': {
                if (!(mqttValue in COURSES)) {
                    console.warn(`ML32PWFOTA: unknown course "${mqttValue}"`)
                    return
                }
                this.selectedCourse = mqttValue
                // Switching course resets the time and temperature controls to that course's own
                // UI default, matching the real web UI's behaviour observed while capturing the
                // course table.
                const def = COURSES[mqttValue].defaultTotalSeconds
                this.cookMinutes = Math.floor(def / 60)
                this.cookSeconds = def % 60
                this.cookTemp = COURSES[mqttValue].defaultTemp ?? 0
                this.publishProperty('course', mqttValue)
                this.publishProperty('cook_time_minutes', this.cookMinutes)
                this.publishProperty('cook_time_seconds', this.cookSeconds)
                this.publishProperty('target_temperature', this.cookTemp)
                return
            }
            case 'cook_time_minutes':
                this.setCookTime(Number(mqttValue) * 60 + this.cookSeconds)
                return
            case 'cook_time_seconds':
                this.setCookTime(this.cookMinutes * 60 + Number(mqttValue))
                return
            case 'target_temperature':
                this.setCookTemp(Number(mqttValue))
                return
            case 'send': {
                const totalSeconds = this.cookMinutes * 60 + this.cookSeconds
                this.send(buildCourseFrame(this.selectedCourse, totalSeconds, this.cookTemp))
                return
            }
            case 'cancel':
                this.send(buildCancel())
                return
            default:
                console.warn(`ML32PWFOTA: attempting to set unknown property ${prop}`)
        }
    }

    /** Applies a 28-byte state record - shared between `40 ec`'s current (second) half and `40
     *  eb`'s single record, which are the same layout (see QUERY_OPCODE's header comment). Same
     *  convention 2REF21EBNSX_3.ts uses for its own `10 ec`/`10 eb` pairing. */
    private applyStateRecord(current: Buffer) {
        const status = current[0]
        this.publishProperty('current_status', decodeStatus(status))
        this.publishProperty('oven_temperature', NO_TEMPERATURE_COURSE_IDS.has(current[1]) ? undefined : current[6])

        // Only meaningful while actually preheating/cooking/cleaning/paused - see file header's
        // ACTIVE COURSE, ACTIVE CLEANING FUNCTION, and REMAINING TIME sections for why this is
        // skipped in every other status, and why "paused" needs record[1] to tell a cooking pause
        // from a cleaning one (current_status alone can't - both report "paused"). Preheating
        // (0x01) and preheating_is_done (0x06) carry the same record[1] course id as a real cook -
        // confirmed live with a 180C 오븐 preheat.
        if (status === 0x01 || status === 0x02 || status === 0x03 || status === 0x04 || status === 0x06) {
            if (current[1] === CLEANING_MARKER) {
                this.publishProperty('active_cleaning_function', decodeCleaningFunction(current[2]))
                this.publishProperty('remaining_time', current[4] * 60 + current[5])
            } else if (current[1] === MY_RECIPE_MARKER) {
                this.publishProperty('active_course', '내가 만든 레시피')
                this.publishProperty('remaining_time', current[3] * 3600 + current[4] * 60 + current[5])
            } else {
                this.publishProperty('active_course', decodeCourseId(current[1]))
                this.publishProperty('remaining_time', current[3] * 3600 + current[4] * 60 + current[5])
            }
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
        // STATE section. Only the second (current) record is applied.
        if (buf.length === 2 + 2 * STATE_RECORD_LEN && buf[0] === STATE_OPCODE_HI && buf[1] === STATE_OPCODE_LO) {
            this.applyStateRecord(buf.subarray(2 + STATE_RECORD_LEN, 2 + 2 * STATE_RECORD_LEN))
            return
        }

        // `40 eb`: a single 28-byte record, same layout as `40 ec`'s current half - a periodic
        // heartbeat/query response (confirmed live 2026-09-10: fires every ~30-70 minutes while
        // idle, and was also caught mid-cook carrying the real course/status/remaining-time, e.g.
        // status=2 cooking_in_progress, record[1]=1 레인지, 27s remaining). Unlike
        // 2REF21EBNSX_3.ts this handler never sends a query frame of its own to request one - this
        // is purely something the appliance already sends on its own that was going unread.
        if (buf.length === 2 + STATE_RECORD_LEN && buf[0] === STATE_OPCODE_HI && buf[1] === QUERY_OPCODE_LO) {
            this.applyStateRecord(buf.subarray(2, 2 + STATE_RECORD_LEN))
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
