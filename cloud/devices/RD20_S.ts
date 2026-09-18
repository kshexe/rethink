import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type DeviceDiscovery } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { note as recordNote } from '../frame-recorder'
import * as energyAccumulator from '../energy-accumulator'

/*
 * LG dryer (건조기), ThinQ model RD20_S, deviceType 202.
 *
 * Shares the AA..BB envelope and the F0 E5 settings-write opcode FX___S.ts (a front-load washer)
 * already documents in detail: `f0 e5 00 02 01 ff <n> [<key> <value...>]*n`, where <n> is the
 * number of key/value pairs that follow. KEY_POWER (0x02) is one of those keys and this appliance
 * answers to the exact same encoding - captured directly against a real unit on 2026-09-09 by
 * clicking the power switch on my.lgthinq.com and reading the resulting frame back off rethink's
 * on-box capture log (`/share/rethink/frames/<date>.jsonl`), matched to the click by timestamp:
 *
 *   to-device   aa 0d f0 e5 00 02 01 ff 01 02 <00=off|01=on> <ck> bb
 *   from-device aa 08 30 00 e5 00 <ck> bb                                (ack)
 *
 * Power on and off were both captured this way, byte for byte identical to MI2D7B (minidryer)
 * and ST_R_ETH01Y_ (styler) except the from-device leading byte (0x30 here, a device-class
 * marker - not asserted against below since nothing here depends on it).
 *
 * The ack is followed by a longer from-device frame (63 bytes total) that starts with the same
 * bytes as ST_R_ETH01Y_'s clean 13-byte power echo - `e6 00 02 01 ff 01 02` - but is not one:
 * that styler echo's next byte is the state that was just set, while this appliance's 63-byte
 * frame has 0x00 there in both the power-on and power-off captures. It is more likely this
 * model's periodic/idle status report sharing a fixed constant preamble, not a targeted echo of
 * the command - see MI2D7B.ts, which hit the exact same thing. `power` is therefore published
 * optimistically from the command this handler itself just sent (see setProperty), not read back
 * off the wire.
 *
 * ALSO OBSERVED but not exposed as controls yet: pressing "건조기에 전송" (send-to-appliance) in
 * the app, with 원격제어 (remote control) off, produces a settings write using the same opcode
 * with more keys attached. Two shapes were captured:
 *
 *   default course, no options checked (short):
 *     f0 e5 00 02 01 ff 00                                     (n=0 - nothing to write)
 *   표준 course with 다림질알림+스팀+구김방지 all checked:
 *     f0 e5 00 02 01 ff 07  1f 02  1e 03  34 01  3f 01  0f 01  70 00 00  7f 00 00
 *
 * Reading the second one against FX___S's key vocabulary: 0x1f is KEY_WATER_TEMP and 0x1e is
 * KEY_WASH there (dry-level/eco-mode analogues here, unconfirmed which option each maps to on
 * this model), 0x7f is KEY_RESERVE (a 16-bit delay-end reservation, 0 here - none set). Keys
 * 0x34, 0x3f and 0x0f do not appear in FX___S's washer vocabulary at all, so they are presumably
 * this model's own option keys (절약모드/건조정도/다림질알림/스팀/구김방지 are the checkboxes
 * that were on when this was captured) - which key is which has not been isolated (all three
 * were toggled on together in the one capture that produced this frame). Neither shape reached
 * the appliance for real (원격제어 was off both times - the app even said so), so this is command
 * *composition* evidence, not proof any of it does what the checkbox claims. Left undecoded on
 * purpose rather than guessed; see RETHINK memory `rethink_migration_status` for the full note.
 *
 * Checked 2026-09-09 whether upstream's own RV13B6BSD_D_US_WIFI.ts/RV13B6ES_D_US_WIFI.ts (other
 * dryers already in this repo) could shortcut decoding the from-device status frames piling up
 * unmodelled here (kind `unmodelled-aabb-frame` in the frame log). They don't transfer: those
 * models decode status off a fixed-offset record (buf[1]==0xEC/0xEB, a marker-led record at a
 * constant offset) - a completely different protocol family from this model's F0E5 key-value
 * scheme above, so none of their byte offsets apply here. The only thing that carried over is
 * two frame-type byte VALUES matching by coincidence, not layout: buf[1]==0x72 (heartbeat) and
 * 0xE2 (idle/keepalive snapshot) appear in both, per upstream's header comment for that model.
 * CORRECTION (2026-09-14) - see the file header's NOTIFICATION section below: at least for THIS
 * model, buf[1]==0x72 is not a heartbeat at all - it appears only twice a day (tied to real
 * completion events, not on any regular interval), so "heartbeat" was upstream's own guess for a
 * different model and does not carry over here any more than the byte-offset layout did.
 *
 * NOTIFICATION (decoded 2026-09-14): cross-referenced the official `lg_thinq` integration's live
 * `event.geonjogi_notification` history (`event_types: [drying_is_complete, drying_failed]`)
 * against this device's own frame log, same technique used for 3REK2G03VI200S_2.ts (kimchi
 * fridge)/ML32PWFOTA.ts (oven)/ST_R_ETH01Y_.ts (styler). A short frame fires right before every
 * real completion:
 *
 *   30 72 00 00 00        (buf[3]=0) = drying_is_complete
 *
 * ~1.1-1.6s before the cloud event, confirmed on 4 independent samples (2026-09-09, 09-11, and
 * twice on 09-13). `drying_failed` has never actually fired, so it is not known what code would
 * carry it.
 *
 * CORRECTION (2026-09-14): `buf[3]=0xc8` was originally lumped into `drying_is_complete` too,
 * since it always showed up right alongside the `0x00` frame at every completion seen so far. A
 * live remote-control toggle test the same day broke that assumption: turning 원격제어 off by
 * itself (mid-idle, no drying involved at all) produces a standalone `30 72 00 c8 00` with no
 * preceding `0x00` frame, and turning it on produces `30 72 00 c9 00`. So `0xc8`/`0xc9` are their
 * own thing - **원격제어 꺼짐/켜짐** - not part of the completion signal; they only ever appeared
 * paired with `0x00` before because the app happens to also drop the remote-control session the
 * moment a cycle finishes. `0xc8`/`0xc9` are read here as a `remote_control` binary_sensor instead
 * of being folded into the `notification` event entity - confirmed by a live on/off/on/off round
 * trip (4 samples, clean reversal each time).
 *
 * REMAINING_MINUTES (decoded 2026-09-10, and corrected the same day - see below): rather than
 * running a fresh test cycle, this was decoded from a real dry cycle already sitting in rethink's
 * own frame log from the day before (retained 14 days per the add-on's `frame_log_days` option) -
 * by cross-referencing the official `lg_thinq` integration's own sensors against rethink's raw
 * frames for the same window. The from-device frame that carries it is a different, longer shape
 * than the `f0e5`-ack one above: `aa ff 30 0a 00 76 00 <2-byte session counter> 00 01 00 ec 00 64
 * <98-byte body>` (118 bytes total). `buf` here (as AABBDevice.processData hands it, i.e. with
 * the leading `aa ff` and trailing checksum/bb already stripped) is 114 bytes; the marker `00 01
 * 00 ec` sits at `buf[7..10]`, and `buf[23]` is a plain integer, minutes remaining in the cycle.
 *
 * First pass (wrong): 3 samples read against `sensor.geonjogi_current_status` (running/cooling/
 * end) alone made `buf[23]` look like a 3-value status enum (0x64=running, 0x02=cooling,
 * 0x01=end), because those samples happened to land right at the start of the run (~100 min left)
 * and near the very end (~1-2 min left). Cross-checking against `sensor.geonjogi_remaining_time`
 * (a predicted finish timestamp) instead, across the same cycle, showed `buf[23]` tracking
 * `finish_time - now` in whole minutes exactly - 99, 74, 58, 11 minutes at four more points across
 * the same run, matching every time. It is not a status code at all, just the countdown - the
 * earlier reading only *looked* like one because a countdown naturally passes through small
 * integers right when a real status enum would too. There likely is a real discrete status/phase
 * byte somewhere in the other ~90 bytes of this frame (the official integration clearly has one),
 * but the running cycle mined for this pass only contained 2 cooling samples and 1 end sample -
 * not enough to isolate it with any confidence, so it is left undecoded rather than guessed at
 * twice. This frame shape stopped appearing entirely once the official sensor read "power_off" -
 * the appliance does not send it while idle, so `remaining_minutes` is simply never published for
 * that state.
 *
 * POWER READ-BACK (decoded 2026-09-12): the 63-byte `e6` frame described above as "not carrying
 * power state" - that conclusion only checked the byte right after the `00 02 01 ff 01 02` prefix
 * (which is indeed always 0x00). The real power bit sits deeper in the same frame: driving the
 * power switch myself on my.lgthinq.com and diffing the immediate command->echo round trip (no
 * timing ambiguity - the echo lands in the same second as the command) shows `buf[33]` (buf being
 * this 58-byte frame as processAABB receives it, i.e. with the leading `aa 3f` and trailing
 * checksum/bb already stripped) is `0x00` right after an OFF command and `0x20` right after an ON
 * command, consistently across repeats. `power` is now read from this byte when the frame arrives,
 * in addition to being published optimistically from `setProperty` (the frame is not otherwise
 * emitted while idle - see MI2D7B.ts's identical case - so the optimistic publish still matters for
 * the moment right after issuing a command from HA before this echo would arrive anyway).
 *
 * STATUS (decoded 2026-09-11): the discrete status/phase byte flagged above as needing more
 * samples - found it once two more complete dry cycles (2026-09-09 and 2026-09-11) had accumulated
 * in the frame log. `buf[89]` (the "new" record's own copy of the same field `buf[39]` carries for
 * the "old" one, same +50 pairing REMAINING_MINUTES_OFFSET uses) takes exactly three values across
 * both cycles, at the same relative point each time: `0x41` while running normally, `0x61` during
 * the cool-down tail, `0x01` on the very last frame before the appliance goes quiet. Confirmed by a
 * sharp corroborating signal in both cycles: `remaining_minutes` itself jumps discontinuously
 * downward (58 -> 11 min in one run, 58 -> 11 in the other) at the exact frame where `buf[89]`
 * flips 0x41 -> 0x61 - the appliance re-estimates a much shorter "time left" once it leaves the
 * main dry phase for cool-down, and that recompute lands on the same frame as the status flip both
 * times. Other values seen for this byte in the wider log (0x00, 0x04, 0x45) were not captured
 * inside a cycle mined closely enough to place with confidence, so they publish as
 * `unknown_<value>` rather than being guessed at.
 *
 * ENERGY (decoded 2026-09-13): `buf[81]` (`buf[31]` is the "old" record's copy of the same field,
 * same +50 pairing as everything else in this frame) is a **1 Wh/count, mod-256 rolling total** -
 * not a delta report like FX___S's `0x3E` or a persistent multi-byte total like
 * 3REK2G03VI200S_2.ts's `11 3E`, just a single byte that increments once per Wh consumed and wraps
 * 255->0. Confirmed against a real full cycle (이불, 00:55-02:32 KST, 97 minutes): the app's own
 * "사용 이력" detail screen for that exact cycle reports "전력 사용량 1.06kWh" (1058 Wh in the
 * underlying `powerUsageAmount` field); the raw byte climbed 0->255 four full times over the same
 * window and ended at 34 - `4*256+34 = 1058`, an exact match. Appears to reset to 0 at the start of
 * each new cycle (the very first status frame of this run already read 0), so the delta computed
 * between two consecutive readings is wrap-safe (`(cur - prev + 256) % 256`) but NOT safe across a
 * gap where the appliance went idle and cycled again in between (this frame shape stops entirely
 * while idle - see REMAINING_MINUTES above - so a reset-to-0 for a new cycle would otherwise be
 * misread as a huge fake delta); guarded by simply discarding any single-step delta implausibly
 * large for a ~5-10s report interval (`ENERGY_MAX_PLAUSIBLE_DELTA`) rather than trying to detect the
 * gap directly. Feeds `energy-accumulator.ts` the same way 3REK2G03VI200S_2.ts/FX___S.ts do.
 *
 * ALARM VOLUME, FEATURE FLAGS, RESERVATION MINUTES, AND `STATUS`'S OWN SECOND JOB (decoded
 * 2026-09-14, live one-control-at-a-time testing while idle, each confirmed by an on/off/value
 * round trip unless noted - and see the CORRECTION note right below, an offset bug in the
 * scratch tooling used for this pass, not in this file, that is worth recording so a future
 * session does not repeat it).
 *
 *   buf[82] (ALARM_VOLUME_OFFSET, right after ENERGY_OFFSET but a distinct byte - not dual-
 *     purpose with it): the appliance's currently configured alarm volume, a plain 0-4 level, but
 *     ONLY while idle (see below) - confirmed both by predicting the value from the on-screen
 *     setting before checking the frame (매우크게→무음→매우크게→무음 round trip, `4→0→4→0`, all
 *     four landing exactly right) and separately by setting 보통 and getting exactly `2`.
 *   buf[87] (FEATURE_FLAGS_OFFSET): 0x08 구김방지(anti-wrinkle) · 0x20 드럼 라이트(drum light) ·
 *     0x40 다림질알림(ironing alert) - each confirmed by an independent on/off reversal.
 *   buf[89] (STATUS_OFFSET - the same byte the STATUS section above already reads): while idle
 *     (never one of the three known running/cooling/complete enum values) this same byte carries
 *     two extra bits instead - 0x08 예약 활성화(reservation active), confirmed by
 *     arming/cancelling a reservation, and 0x10 버튼잠금(button lock), confirmed by toggling the
 *     lock. Safe to read unconditionally alongside the enum: neither bit is ever set in any of
 *     the three confirmed running-family values (0x41/0x61/0x01), so decodeStatus() itself is
 *     untouched and these are just two more bits masked off the same read.
 *   buf[70..71] (RESERVATION_MINUTES_OFFSET, 16-bit big-endian): the armed reservation's delay in
 *     plain minutes - `00 b4` (180) for a 3-hour reservation, `04 74` (1140) for a 19-hour one,
 *     back to `00 00` on cancel. The 2-byte width was only obvious once the 19h test pushed it
 *     past 255 (the 3h sample alone read identically whether it was 1 byte or 2 with a zero high
 *     byte).
 *
 * CORRECTION, same day: the scratch python used to diff live frames during this pass sliced the
 * captured hex as a *string* (`hex[2:-2]`, dropping 2 hex *characters* = 1 byte off each end) and
 * then subtracted 2 from an index into that to guess the real `buf[]` offset - AABBDevice actually
 * strips 2 full *bytes* off each end (`buf.subarray(2, buf.length - 2)`), so the right correction
 * was -1, not -2, and every offset that scratch tooling reported was one low. First noticed when
 * `alarm_volume`'s naive offset (81) turned out to be literally `ENERGY_OFFSET`, implying the same
 * byte somehow meant two things depending on state - re-deriving every one of this section's
 * offsets against the *correctly* sliced buffer (using the already-validated ENERGY_OFFSET(81)/
 * STATUS_OFFSET(89)/REMAINING_MINUTES_OFFSET(73) as known-good anchors to check the fix against)
 * resolved that: there is no dual-purpose byte for ENERGY at all, alarm_volume simply lives one
 * byte later at 82. STATUS(89) truly is reused for the lock/reservation bits, though - re-checked
 * against the original validated running/cooling/complete fixtures, which read `unknown_N` at this
 * offset never once by coincidence collides with 0x08 or 0x10, so no regression there either. The
 * energy delta logic itself needed no gating fix in the end (the original always-record-every-
 * frame behavior was already correct) - it only looked buggy because the earlier pass of this same
 * mistake made a volume-level change look like it was landing in the energy byte.
 */

const FROM_DEVICE_ACK_OPCODE = 0xe5

/** Shared with FX___S.ts's vocabulary for the same F0E5 protocol family. */
const KEY_POWER = 0x02

/** The `00 01 00 ec` marker (see file header's REMAINING_MINUTES section) that opens the 114-byte
 *  status body AABBDevice.processData hands to processAABB, and where the remaining-minutes byte
 *  lives within it. */
const STATUS_FRAME_LEN = 114
const STATUS_MARKER = Buffer.from([0x00, 0x01, 0x00, 0xec])
const STATUS_MARKER_OFFSET = 7
// The frame carries two records, old then new (the same convention 2REF21EBNSX_3.ts's `10 ec`
// state frame uses) - this is the new/current one, 50 bytes after the old record's own offset.
const REMAINING_MINUTES_OFFSET = 73

/** See the file header's STATUS section. Same old/new +50 pairing as REMAINING_MINUTES_OFFSET. */
const STATUS_OFFSET = 89

/** See the file header's ENERGY section. */
const ENERGY_OFFSET = 81
/** A real report every few seconds at dryer wattage does not add more than this many Wh in one
 *  step - anything above is a cycle-boundary reset (see file header), not a real delta. */
const ENERGY_MAX_PLAUSIBLE_DELTA = 50

/** See the file header's decoded-2026-09-14 section - a distinct byte from ENERGY_OFFSET, not
 *  dual-purpose with it. Only meaningful (and only read) while STATUS is not one of the three
 *  running-family values. */
const ALARM_VOLUME_OFFSET = 82
const ALARM_VOLUME_NAMES: Record<number, string> = {
    0: 'mute',
    1: 'low',
    2: 'medium',
    3: 'high',
    4: 'very_high',
}

/** See the file header's decoded-2026-09-14 section. */
const FEATURE_FLAGS_OFFSET = 87
const FEATURE_ANTI_WRINKLE = 0x08
const FEATURE_DRUM_LIGHT = 0x20
const FEATURE_IRONING_ALERT = 0x40

/** See the file header's decoded-2026-09-14 section - two extra bits on STATUS_OFFSET itself,
 *  not a separate byte; never set in any of the three confirmed running-family enum values. */
const OPTION_RESERVATION_ACTIVE = 0x08
const OPTION_BUTTON_LOCK = 0x10

const RESERVATION_MINUTES_OFFSET = 70

/** See the file header's NOTIFICATION CORRECTION section - not part of the `notification` event
 *  entity, read instead as a `remote_control` binary_sensor. */
const NOTIFY_REMOTE_OFF = 0xc8
const NOTIFY_REMOTE_ON = 0xc9

/** See the file header's POWER READ-BACK section. */
const POWER_ECHO_TYPE = 0xe6
const POWER_ECHO_LEN = 58
const POWER_OFFSET = 33

/** See the file header's NOTIFICATION section. Same <sub> 72 <payload> convention
 *  ST_R_ETH01Y_.ts/MI2D7B.ts use, sub=0x30 for this model; not a fixed frame length. */
const NOTIFY_SUB = 0x30
const NOTIFY_OPCODE = 0x72
const NOTIFY_CODE_OFFSET = 3
const NOTIFICATION: Record<number, string> = {
    0: 'drying_is_complete',
}
const NOTIFICATION_OPTIONS = [...new Set(Object.values(NOTIFICATION))]

const STATUS_NAMES: Record<number, string> = {
    0x41: 'running',
    0x61: 'cooling',
    0x01: 'complete',
}

function decodeStatus(raw: number): string {
    return STATUS_NAMES[raw] ?? `unknown_${raw}`
}

/** Builds the `f0 e5 00 02 01 ff <n> [<key> <value>]*n` payload AABBDevice.send() wraps and
 *  checksums. Only single-byte values are needed for power; see the file header for the
 *  multi-key, partly-16-bit shape this opcode also carries on this model. */
function buildSettingsWrite(pairs: [key: number, value: number][]): Buffer {
    const body = [0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff, pairs.length]
    for (const [key, value] of pairs) body.push(key, value)
    return Buffer.from(body)
}

/** ACTIVE QUERY (2026-09-12): 2REF21EBNSX_3.ts/3REK2G03VI200S_2.ts (a different opcode family,
 *  `0x10`/`0x11` sub-byte vs this model's `0x30`) both poll with this exact fixed frame and get a
 *  real status record back - it works here too. Sent once on connect only, not on a repeating
 *  timer: this appliance already broadcasts its own course-table frame every 1-2s on its own,
 *  unprompted - confirmed 2026-09-13 by watching the live frame log with no query in flight at
 *  all. Re-asking every 5 minutes bought nothing beyond that one initial connect-time answer (the
 *  retracted power byte was never republished anyway), so a periodic re-query was dropped as dead
 *  weight; the appliance's own continuous chatter is what would carry a future decoded field
 *  instead. */
const QUERY_FRAME = Buffer.from('f0ed1211010000010400', 'hex')

export default class Device extends AABBDevice {
    power: boolean | undefined
    status: string | undefined
    remoteControl: boolean | undefined

    /** The last raw (mod-256) energy byte seen, to compute the next delta against - see the file
     *  header's ENERGY section. `undefined` until the first status frame arrives. */
    private lastEnergyRaw: number | undefined

    /** (dir:tag) pairs already flagged as unrecognised, so a repeating one is noted once. */
    private seenUnknown = new Set<string>()
    private cancelEnergyRefresh: (() => void) | undefined

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
                    icon: 'mdi:tumble-dryer',
                },
                remaining_minutes: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining_minutes',
                    state_topic: '$this/remaining_minutes',
                    name: 'Remaining time',
                    icon: 'mdi:timer-outline',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                },
                // See the file header's STATUS section - only running/cooling/complete are
                // confirmed, anything else publishes as unknown_<value> rather than being guessed.
                status: {
                    platform: 'sensor',
                    unique_id: '$deviceid-status',
                    state_topic: '$this/status',
                    name: 'Status',
                    icon: 'mdi:tumble-dryer',
                },
                // Calendar-boundary Wh figures fed by the file header's ENERGY byte, via
                // energy-accumulator.ts - survive the raw counter's own per-cycle resets.
                energy_hour: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_hour',
                    name: 'Energy this hour',
                    icon: 'mdi:lightning-bolt',
                    device_class: 'energy',
                    unit_of_measurement: 'Wh',
                    state_class: 'total_increasing',
                    state_topic: '$this/energy_hour',
                },
                energy_day: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_day',
                    name: 'Energy today',
                    icon: 'mdi:lightning-bolt',
                    device_class: 'energy',
                    unit_of_measurement: 'Wh',
                    state_class: 'total_increasing',
                    state_topic: '$this/energy_day',
                },
                energy_month: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_month',
                    name: 'Energy this month',
                    icon: 'mdi:lightning-bolt',
                    device_class: 'energy',
                    unit_of_measurement: 'Wh',
                    state_class: 'total_increasing',
                    state_topic: '$this/energy_month',
                },
                energy_total: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_total',
                    name: 'Energy total',
                    icon: 'mdi:lightning-bolt',
                    device_class: 'energy',
                    unit_of_measurement: 'Wh',
                    state_class: 'total_increasing',
                    state_topic: '$this/energy_total',
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
                // See the file header's NOTIFICATION CORRECTION section - 0xc8/0xc9 on the same
                // channel as `notification` above, split out since it is a state, not an event.
                remote_control: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-remote_control',
                    state_topic: '$this/remote_control',
                    name: 'Remote control',
                    icon: 'mdi:remote',
                    entity_category: 'diagnostic',
                },
                // See the file header's "FEATURE/OPTION FLAG BYTES" section - all four read-only,
                // the write side for any of them has not been captured/confirmed yet.
                drum_light: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-drum_light',
                    state_topic: '$this/drum_light',
                    name: 'Drum light',
                    icon: 'mdi:lightbulb-outline',
                    entity_category: 'diagnostic',
                },
                anti_wrinkle: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-anti_wrinkle',
                    state_topic: '$this/anti_wrinkle',
                    name: 'Anti-wrinkle',
                    icon: 'mdi:tshirt-crew-outline',
                    entity_category: 'diagnostic',
                },
                ironing_alert: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-ironing_alert',
                    state_topic: '$this/ironing_alert',
                    name: 'Ironing alert',
                    icon: 'mdi:iron-outline',
                    entity_category: 'diagnostic',
                },
                button_lock: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-button_lock',
                    state_topic: '$this/button_lock',
                    name: 'Button lock',
                    icon: 'mdi:lock-outline',
                    entity_category: 'diagnostic',
                },
                // See the file header's "FEATURE/OPTION FLAG BYTES" section. 0 when no
                // reservation is armed.
                reservation_minutes: {
                    platform: 'sensor',
                    unique_id: '$deviceid-reservation_minutes',
                    state_topic: '$this/reservation_minutes',
                    name: 'Reservation',
                    icon: 'mdi:timer-plus-outline',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    entity_category: 'diagnostic',
                },
                // See the file header's "ENERGY BYTE IS DUAL-PURPOSE" section - only published
                // while STATUS reads 'idle'; not touched at all while running.
                alarm_volume: {
                    platform: 'sensor',
                    unique_id: '$deviceid-alarm_volume',
                    state_topic: '$this/alarm_volume',
                    name: 'Alarm volume',
                    icon: 'mdi:volume-high',
                    entity_category: 'diagnostic',
                },
            },
        })

        this.setConfig(config)
        log(
            'status',
            this.id,
            'RD20_S (건조기) handler started - power, remaining_minutes, status, energy, alarm_volume, feature flags, reservation, notification, remote_control, see file header',
        )
    }

    start() {
        super.start()
        this.send(QUERY_FRAME)
        this.cancelEnergyRefresh = energyAccumulator.scheduleHourlyRefresh(this.id, (stats) =>
            this.publishEnergyStats(stats),
        )
    }

    cancelPendingWork() {
        this.cancelEnergyRefresh?.()
        this.cancelEnergyRefresh = undefined
        super.cancelPendingWork()
    }

    /** Adds a newly-seen Wh delta (see the file header's ENERGY section) and republishes the
     *  calendar-boundary figures. */
    private async recordEnergyDelta(deltaWh: number) {
        this.publishEnergyStats(await energyAccumulator.addDelta(this.id, deltaWh))
    }

    private publishEnergyStats(stats: energyAccumulator.EnergyStats) {
        this.publishProperty('energy_hour', stats.hourWh)
        this.publishProperty('energy_day', stats.dayWh)
        this.publishProperty('energy_month', stats.monthWh)
        this.publishProperty('energy_total', stats.totalWh)
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'power': {
                const on = mqttValue === 'ON'
                this.send(buildSettingsWrite([[KEY_POWER, on ? 1 : 0]]))
                // Optimistic: see the file header for why this is not read back off the wire.
                this.power = on
                this.publishProperty('power', on ? 'ON' : 'OFF')
                return
            }
            default:
                console.warn(`RD20_S: attempting to set unknown property ${prop}`)
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

        // notification channel: <sub=0x30> 72 <payload> - see the file header's NOTIFICATION
        // section. Frame length is not fixed, so only the sub/opcode/gate byte are checked.
        if (buf[0] === NOTIFY_SUB && buf[1] === NOTIFY_OPCODE && buf.length > NOTIFY_CODE_OFFSET && buf[2] === 0) {
            const code = buf[NOTIFY_CODE_OFFSET]

            // See the file header's NOTIFICATION CORRECTION section - a state, not an event.
            if (code === NOTIFY_REMOTE_ON || code === NOTIFY_REMOTE_OFF) {
                const on = code === NOTIFY_REMOTE_ON
                if (on !== this.remoteControl) {
                    this.remoteControl = on
                    this.publishProperty('remote_control', on ? 'ON' : 'OFF')
                }
                return
            }

            const name = NOTIFICATION[code]
            if (name !== undefined) this.publishEvent('notification', name)
            return
        }

        // 114-byte status frame carrying the `00 01 00 ec` marker - see file header's
        // REMAINING_MINUTES section. Only this one field is decoded; the rest of the body is not.
        if (
            buf.length === STATUS_FRAME_LEN &&
            buf.subarray(STATUS_MARKER_OFFSET, STATUS_MARKER_OFFSET + STATUS_MARKER.length).equals(STATUS_MARKER)
        ) {
            this.publishProperty('remaining_minutes', buf[REMAINING_MINUTES_OFFSET])

            const status = decodeStatus(buf[STATUS_OFFSET])
            if (status !== this.status) {
                this.status = status
                this.publishProperty('status', status)
            }

            // See the file header's ENERGY section - a mod-256 rolling Wh counter, so the delta
            // since the last reading wraps safely; a delta this large in one step can only be a
            // cycle-boundary reset, not real consumption, and is discarded rather than counted.
            const energyRaw = buf[ENERGY_OFFSET]
            if (this.lastEnergyRaw !== undefined) {
                const delta = (energyRaw - this.lastEnergyRaw + 256) % 256
                if (delta > 0 && delta <= ENERGY_MAX_PLAUSIBLE_DELTA) void this.recordEnergyDelta(delta)
            }
            this.lastEnergyRaw = energyRaw

            // See the file header's decoded-2026-09-14 section - only meaningful while idle
            // (STATUS is not one of the three running-family values); not published otherwise,
            // rather than publishing a number that has no relation to alarm volume mid-cycle.
            if (!(buf[STATUS_OFFSET] in STATUS_NAMES)) {
                const raw = buf[ALARM_VOLUME_OFFSET]
                this.publishProperty('alarm_volume', ALARM_VOLUME_NAMES[raw] ?? `unknown_${raw}`)
            }

            // See the file header's decoded-2026-09-14 section.
            const features = buf[FEATURE_FLAGS_OFFSET]
            this.publishProperty('drum_light', features & FEATURE_DRUM_LIGHT ? 'ON' : 'OFF')
            this.publishProperty('anti_wrinkle', features & FEATURE_ANTI_WRINKLE ? 'ON' : 'OFF')
            this.publishProperty('ironing_alert', features & FEATURE_IRONING_ALERT ? 'ON' : 'OFF')

            // OPTION_RESERVATION_ACTIVE (0x08, also on STATUS_OFFSET) is not separately exposed -
            // reservation_minutes already carries the same information (0 = none armed) without
            // needing a second entity.
            this.publishProperty('button_lock', buf[STATUS_OFFSET] & OPTION_BUTTON_LOCK ? 'ON' : 'OFF')

            this.publishProperty('reservation_minutes', buf.readUInt16BE(RESERVATION_MINUTES_OFFSET))
            return
        }

        // The 58-byte `e6` echo of a power command - see file header's POWER READ-BACK section.
        if (buf.length === POWER_ECHO_LEN && buf[1] === POWER_ECHO_TYPE) {
            const on = buf[POWER_OFFSET] !== 0
            if (on !== this.power) {
                this.power = on
                this.publishProperty('power', on ? 'ON' : 'OFF')
            }
            return
        }

        // Response to the TRIAL query above (MSG_TUNNEL, buf[1]===0x0a, wrapping a 0xEB record) -
        // TRIED AND RETRACTED (2026-09-12), same as H01.ts's identical analogy: the equivalent
        // byte there turned out not to track power at all (settled on the wrong value against a
        // confirmed-ON appliance). Recognised here only so it does not spam the unmodelled log;
        // nothing is read from it.
        if (buf[1] === 0x0a) {
            const extended = buf.readUInt16BE(2) === buf.length + 4
            const payload = extended ? buf.subarray(4) : buf.subarray(2)
            if (payload.length > 10 && payload[6] === 0xeb) return
        }

        // Anything else is a frame this handler does not parse yet (the 63-byte periodic status
        // report, course table, options). Note it once per shape so a future session has
        // something to grep for, the same way TLVDevice.noteUnknownTags does for the AC family.
        const key = buf.length > 0 ? `${buf.length}:${buf[0].toString(16)}:${(buf[1] ?? 0).toString(16)}` : 'empty'
        if (!this.seenUnknown.has(key)) {
            this.seenUnknown.add(key)
            log('status', this.id, `RD20_S: unrecognised frame shape (len=${buf.length}, buf[0..1]=${key})`)
            recordNote(this.id, this.thinq.meta, 'unmodelled-aabb-frame', { len: buf.length, head: key })
        }
    }
}
