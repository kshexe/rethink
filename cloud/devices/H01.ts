import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type DeviceDiscovery } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { note as recordNote } from '../frame-recorder'

/*
 * LG dishwasher (식기세척기), ThinQ model H01.
 *
 * Shares the AA..BB envelope with the rest of this fork's AABB-family handlers, but speaks a
 * different opcode vocabulary than the F0E5 key-value scheme MI2D7B/RD20_S/ST_R_ETH01Y_ use:
 * this model's settings writes are `f0 <opcode> <value...>` with no length/subtype wrapper at
 * all - captured directly against a real unit on 2026-09-10 via my.lgthinq.com (DNAT-redirected
 * to rethink, bridge mode relaying to the real LG cloud so the app's own commands reach it),
 * matched to the click by timestamp:
 *
 *   to-device   aa 07 f0 26 <12=off|16=on> <ck> bb
 *   from-device aa 08 32 00 26 00 <ck> bb                                (ack)
 *
 * Powering on first showed a confirm dialog in the app ("전원을 켤까요?") that has to be accepted
 * before the command is sent at all - this handler has no way to satisfy that itself, but HA's
 * own optimistic switch never needed to: the write above is everything the confirm dialog gates,
 * and once accepted it worked cleanly.
 *
 * `power` used to be published optimistically only (not read back off the wire) - see STATUS
 * RECORD below for why that changed on 2026-09-13.
 *
 * STATUS RECORD (decoded 2026-09-13): the 0xEC dual-record status frame (two back-to-back copies
 * of the same 26-byte record, old then new - `buf` here is `AABBDevice.processData`'s stripped
 * body, so `buf[0..1]` is the `32 ec` marker, the old record is `buf[2..27]` and the new one is
 * `buf[28..53]`; the 0xEB query response, see QUERY_FRAME below, carries the same 26-byte record
 * shape once, at `buf[2..27]`) was cracked open by physically toggling power and every course/
 * option button on the real appliance, one control at a time, and diffing which byte(s) moved -
 * the same technique that had earlier been tried with far fewer samples and got `power` wrong
 * (see the retraction this replaces, further down). `record` below means either record slice.
 * Bytes within `record` (0-indexed):
 *
 *   record[2]  - power: 0x01 = on, 0x04 = off. Confirmed clean across 4 full on/off cycles run
 *                back to back, always reverting to exactly these two values with nothing else
 *                touched - unlike the very similar-looking but ultimately unrelated byte at the
 *                same relative offset in RD20_S.ts/MI2D7B.ts's own e6 echo (different frame
 *                family, not this one) or this file's own retracted `buf[28]` attempt below.
 *   record[5]  - hours of the course's total expected duration (record[9] is an exact copy).
 *   record[6]  - minutes of the same (record[10] is an exact copy). Matched the appliance's own
 *                on-screen "시:분" readout exactly across 5 separate course/option changes (55분,
 *                2h20m, 2h50m, 1h37m, 2h00m, ...).
 *   record[7]  - the selected course's index. Confirmed distinct per named course (자동=1,
 *                강력=2, 표준=5, 통살균=9, 건조단독=15, 야간조용=16), but NOT stable for the
 *                "다운로드" (downloaded course) slot - there it reflects which of the 12
 *                downloadable programs (P1..P12) is currently active on the appliance (11 was
 *                seen with "플라스틱 (P12, 다운로드됨)" active), not a fixed identity for
 *                "다운로드" itself. Published as a raw number, not a name, for this reason.
 *   record[11] - reservation delay in hours, 0 (also its "off" value - a lone press cycles this
 *                up to 11 and then wraps back to 0, clearing the record[14] 0x01 bit at the same
 *                time) through 11.
 *   record[14] - an option bitfield, confirmed one bit at a time with nothing else changing:
 *                  0x80 steam / 0x40 intensive wash (top rack) / 0x20 intensive wash (bottom
 *                  rack) / 0x08 high-temp sterilize / 0x01 reservation armed. (0x10/0x02/0x04
 *                  not seen set here - 0x04 lives in record[17] instead, see below.)
 *   record[17] - `0x0b` (constant base - bits 0/1/3, never seen otherwise) `|` (hot-air-dry tier
 *                `<< 4`, 0=off/1=40min/2=60min/3=90min - each step confirmed by pressing the
 *                appliance's 열풍건조 button once and reading back exactly `+0x10`) `|` `0x04`
 *                (안심헹굼/extra rinse, confirmed as an isolated single-bit change with nothing
 *                else in the record moving).
 *
 * NOT YET DECODED: course *names* beyond the 7 confirmed above, actually starting a cycle
 * remotely, and the low bits (0x10/0x02) of record[14] (never observed set - likely options this
 * unit's course/panel combination never exercised, e.g. 조용히 세척).
 *
 * SETTINGS BITFIELD WRITE (captured 2026-09-18): the 설정 screen's six toggles (제품 알림음/
 * 세척종료음/필터 교체 알림/세척 완료 알림등/전면 시간 표시/자동 설정/보관 - one more than the
 * screen's own count since 코스자동최적화-style entries live elsewhere) turned out to need the
 * appliance powered ON to even be clickable in the app at all - every one of them stayed visibly
 * greyed out while `power` read off, confirmed by turning the unit on for this capture and back
 * off again afterward. Unlike the F0E5 key-value opcode MI2D7B/RD20_S/ST_R_ETH01Y_ use, this
 * model's settings write is a **whole-bitfield resend**, not a single key/value pair - every write
 * carries all six controls' current values, not just the one being changed:
 *
 *   to-device   aa 0e f0 26 00 00 <byte4> <byte5> 00 00 00 00 <ck> bb
 *   from-device aa 08 32 00 26 00 <ck> bb                                (ack, same shape as power's)
 *
 * Both directions of all six controls were captured directly (each toggled on a real unit, then
 * reverted to restore the appliance's original settings). `byte4`/`byte5` bit layout - see
 * WRITE_* constants below:
 *
 *   byte4: 0x08 세척 완료 알림등 · 0x10 전면 시간 표시 · 0x20 자동 설정 · 0x40 세척 종료음 ·
 *          0x80 보관 (fully accounted for - baseline 0xb8 is exactly these five bits with only
 *          세척종료음 off, no leftover unknown bits in this byte)
 *   byte5: 0x02 필터 교체 알림, bit 0x80 always observed set (baseline 0x82) - meaning
 *          unconfirmed, carried through unchanged on every write rather than guessed at
 *
 * The very next 0xEC status frame after each write showed the SAME six settings at different bit
 * positions within the already-decoded 26-byte record - a different encoding for read vs write,
 * the same story RD20_S.ts's F0E5 keys vs its own status bits already tell:
 *
 *   record[13]: 0x10 자동 설정 · 0x40 세척 완료 알림등
 *   record[17]: 0x08 전면 시간 표시 - inside the ALREADY-decoded REC_DRY byte. The "0x0b constant
 *               base (bits 0/1/3), never seen otherwise" note in the file header's original STATUS
 *               RECORD section was wrong about bit 3 specifically: baseline reads 0x0b with the
 *               front-time-display default ON, and toggling it off for real lands exactly on 0x03
 *               (bits 0/1 only) - bit 3 is this setting, not a constant. extra_rinse (0x04) and the
 *               dry tier (0x30) are unaffected and still decoded the same way they always were.
 *   record[18]: 0x01 보관 · 0x04 세척 종료음 · 0x10 필터 교체 알림, bits 0x80/0x02 always observed
 *               set - two more unconfirmed-meaning bits, distinct from byte5's own unknown bit
 *               above (different byte, no reason to assume they are the same flag)
 *
 * Composing a write therefore means reading the CURRENT value of all six controls off the last
 * status record seen, changing only the one being set, and re-encoding all six into byte4/byte5 -
 * see sendSettings(). The same pattern FX___S.ts's setReservation()/setExtendedCourse() already
 * use for their own multi-field resends. If no status record has been seen yet, the write is
 * skipped rather than sent with fabricated zeros for the other five controls' current state.
 *
 * POWER READ-BACK - FIRST ATTEMPT, TRIED AND RETRACTED (2026-09-12), SUPERSEDED ABOVE: `buf[28]`
 * of the 0xEC dual-record status frame looked like power at first - reading `0x00` right after
 * OFF and `0x08` right after ON, both directions, driving the switch myself on my.lgthinq.com.
 * That held up for exactly those two samples. A real physical on/off at the appliance the same
 * day broke it: `buf[28]` oscillated 0/8 repeatedly across a single on-then-off (not a clean pair
 * of readings), then settled on `0` while the appliance was confirmed still ON - flatly wrong, not
 * just noisy during a transition. The 2026-09-13 pass above found the real power byte sits at a
 * different offset (`record[2]`, i.e. `buf[4]`/`buf[30]`) - `buf[28]` itself (`record[0]`) turned
 * out to just be independent noise, seen flipping on its own on a schedule unrelated to power or
 * anything else decoded here.
 */

const ACK_SUB = 0x32
const ACK_OPCODE = 0x26
const STATUS_TYPE = 0xec
const RECORD_LEN = 26
const STATUS_MIN_LEN = 2 + RECORD_LEN

/** Offsets within one 26-byte status record - see the file header's STATUS RECORD section. */
const REC_POWER = 2
const REC_HOURS = 5
const REC_MINUTES = 6
const REC_COURSE_INDEX = 7
const REC_RESERVATION_HOURS = 11
const REC_OPTIONS = 14
const REC_DRY = 17

const OPT_STEAM = 0x80
const OPT_INTENSIVE_TOP = 0x40
const OPT_INTENSIVE_BOTTOM = 0x20
const OPT_HIGH_TEMP_STERILIZE = 0x08
const OPT_RESERVATION_ARMED = 0x01

const DRY_EXTRA_RINSE_BIT = 0x04
const DRY_TIER_MINUTES = [0, 40, 60, 90] as const
/** See the file header's SETTINGS BITFIELD WRITE section - a bit inside the REC_DRY byte above,
 *  previously lumped into an assumed-constant base. */
const DRY_TIME_DISPLAY_BIT = 0x08

/** See the file header's SETTINGS BITFIELD WRITE section. */
const REC_SETTINGS_A = 13
const SETTINGS_A_AUTO_SELECT = 0x10
const SETTINGS_A_WASH_COMPLETE_LIGHT = 0x40

/** See the file header's SETTINGS BITFIELD WRITE section. */
const REC_SETTINGS_B = 18
const SETTINGS_B_COOL_DRY = 0x01
const SETTINGS_B_END_MELODY = 0x04
const SETTINGS_B_AIR_FILTER_REMINDER = 0x10

/** Write-side bit layout for the settings bitfield write - see the file header. Deliberately not
 *  the same bit positions (or even the same byte groupings) as the SETTINGS_A/B/DRY read-side
 *  constants above; this protocol's write and read encodings for one setting are not required to
 *  match each other. */
const WRITE_WASH_COMPLETE_LIGHT = 0x08
const WRITE_TIME_DISPLAY = 0x10
const WRITE_AUTO_SELECT = 0x20
const WRITE_END_MELODY = 0x40
const WRITE_COOL_DRY = 0x80
const WRITE_AIR_FILTER_REMINDER = 0x02
/** Always observed as 1 (byte5's baseline is 0x82) - meaning unconfirmed, carried through
 *  unchanged on every write rather than guessed at. */
const WRITE_BYTE5_UNKNOWN_BIT = 0x80

function buildPowerWrite(on: boolean): Buffer {
    return Buffer.from([0xf0, 0x26, on ? 0x16 : 0x12])
}

/** See the file header's SETTINGS BITFIELD WRITE section. */
function buildSettingsWrite(byte4: number, byte5: number): Buffer {
    return Buffer.from([0xf0, 0x26, 0x00, 0x00, byte4, byte5, 0x00, 0x00, 0x00, 0x00])
}

/** ACTIVE QUERY (2026-09-12, see RD20_S.ts's identical constant): this fridge-family query frame
 *  also elicits a real response here, even though nothing is read from it any more (see the
 *  processAABB comment below). Sent once on connect only, not on a repeating timer: this
 *  appliance already broadcasts its own 0xEC status frame every couple of minutes on its own,
 *  unprompted - confirmed 2026-09-13 by watching the live frame log with no query in flight at
 *  all. Re-asking every 5 minutes bought nothing beyond that one initial connect-time answer (the
 *  retracted power byte was never republished anyway), so a periodic re-query was dropped as dead
 *  weight; the appliance's own continuous chatter is what would carry a future decoded field
 *  instead. */
const QUERY_FRAME = Buffer.from('f0ed1211010000010400', 'hex')

export default class Device extends AABBDevice {
    power: boolean | undefined

    /** The most recently seen 26-byte status record (old or new copy, whichever arrived last) -
     *  see the file header's SETTINGS BITFIELD WRITE section for why a settings write needs this. */
    private lastRecord: Buffer | undefined

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
                    icon: 'mdi:dishwasher',
                },
                // See the file header's STATUS RECORD section for all of the below.
                duration_minutes: {
                    platform: 'sensor',
                    unique_id: '$deviceid-duration_minutes',
                    state_topic: '$this/duration_minutes',
                    name: 'Course duration',
                    icon: 'mdi:timer-outline',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                },
                // Raw index, not a name - see the file header for why "다운로드" specifically
                // does not have a fixed identity here.
                course_index: {
                    platform: 'sensor',
                    unique_id: '$deviceid-course_index',
                    state_topic: '$this/course_index',
                    name: 'Course index',
                    icon: 'mdi:format-list-numbered',
                    entity_category: 'diagnostic',
                },
                reservation_hours: {
                    platform: 'sensor',
                    unique_id: '$deviceid-reservation_hours',
                    state_topic: '$this/reservation_hours',
                    name: 'Reservation delay',
                    icon: 'mdi:clock-start',
                    device_class: 'duration',
                    unit_of_measurement: 'h',
                },
                steam: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-steam',
                    state_topic: '$this/steam',
                    name: 'Steam',
                    icon: 'mdi:kettle-steam',
                },
                intensive_wash_top: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-intensive_wash_top',
                    state_topic: '$this/intensive_wash_top',
                    name: 'Intensive wash (top rack)',
                    icon: 'mdi:tray-arrow-up',
                },
                intensive_wash_bottom: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-intensive_wash_bottom',
                    state_topic: '$this/intensive_wash_bottom',
                    name: 'Intensive wash (bottom rack)',
                    icon: 'mdi:tray-arrow-down',
                },
                high_temp_sterilize: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-high_temp_sterilize',
                    state_topic: '$this/high_temp_sterilize',
                    name: 'High-temp sterilize',
                    icon: 'mdi:thermometer-high',
                },
                extra_rinse: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-extra_rinse',
                    state_topic: '$this/extra_rinse',
                    name: 'Extra rinse',
                    icon: 'mdi:water-check',
                },
                hot_air_dry_minutes: {
                    platform: 'sensor',
                    unique_id: '$deviceid-hot_air_dry_minutes',
                    state_topic: '$this/hot_air_dry_minutes',
                    name: 'Hot air dry',
                    icon: 'mdi:air-filter',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                },
                // See the file header's SETTINGS BITFIELD WRITE section for all six below. Only
                // writable while the appliance is powered on - confirmed by the app itself greying
                // these out while off.
                end_melody: {
                    platform: 'switch',
                    unique_id: '$deviceid-end_melody',
                    state_topic: '$this/end_melody',
                    command_topic: '$this/end_melody/set',
                    name: 'End melody',
                    icon: 'mdi:bell-ring-outline',
                    entity_category: 'config',
                },
                air_filter_reminder: {
                    platform: 'switch',
                    unique_id: '$deviceid-air_filter_reminder',
                    state_topic: '$this/air_filter_reminder',
                    command_topic: '$this/air_filter_reminder/set',
                    name: 'Air filter reminder',
                    icon: 'mdi:air-filter',
                    entity_category: 'config',
                },
                wash_complete_light: {
                    platform: 'switch',
                    unique_id: '$deviceid-wash_complete_light',
                    state_topic: '$this/wash_complete_light',
                    command_topic: '$this/wash_complete_light/set',
                    name: 'Wash complete indicator light',
                    icon: 'mdi:led-on',
                    entity_category: 'config',
                },
                time_display: {
                    platform: 'switch',
                    unique_id: '$deviceid-time_display',
                    state_topic: '$this/time_display',
                    command_topic: '$this/time_display/set',
                    name: 'Front time display',
                    icon: 'mdi:clock-outline',
                    entity_category: 'config',
                },
                auto_select: {
                    platform: 'switch',
                    unique_id: '$deviceid-auto_select',
                    state_topic: '$this/auto_select',
                    command_topic: '$this/auto_select/set',
                    name: 'Auto select',
                    icon: 'mdi:auto-fix',
                    entity_category: 'config',
                },
                cool_dry: {
                    platform: 'switch',
                    unique_id: '$deviceid-cool_dry',
                    state_topic: '$this/cool_dry',
                    command_topic: '$this/cool_dry/set',
                    name: 'Cool dry (storage)',
                    icon: 'mdi:snowflake-melt',
                    entity_category: 'config',
                },
            },
        })

        this.setConfig(config)
        log(
            'status',
            this.id,
            'H01 (식기세척기) handler started - power, six settings toggles; see file header for what is decoded',
        )
    }

    start() {
        super.start()
        this.send(QUERY_FRAME)
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'power': {
                const on = mqttValue === 'ON'
                this.send(buildPowerWrite(on))
                // Optimistic for a snappy UI - the real status record (see STATUS RECORD in the
                // file header, record[REC_POWER]) also confirms this shortly after, in processAABB.
                this.power = on
                this.publishProperty('power', on ? 'ON' : 'OFF')
                return
            }
            case 'end_melody':
                return this.setSetting('end_melody', 'endMelody', mqttValue === 'ON')
            case 'air_filter_reminder':
                return this.setSetting('air_filter_reminder', 'airFilterReminder', mqttValue === 'ON')
            case 'wash_complete_light':
                return this.setSetting('wash_complete_light', 'washCompleteLight', mqttValue === 'ON')
            case 'time_display':
                return this.setSetting('time_display', 'timeDisplay', mqttValue === 'ON')
            case 'auto_select':
                return this.setSetting('auto_select', 'autoSelect', mqttValue === 'ON')
            case 'cool_dry':
                return this.setSetting('cool_dry', 'coolDry', mqttValue === 'ON')
            default:
                console.warn(`H01: attempting to set unknown property ${prop}`)
        }
    }

    /** Shared by all six settings-bitfield switches - see the file header's SETTINGS BITFIELD
     *  WRITE section. Composes a full byte4/byte5 write from the last status record seen plus this
     *  one changed control, then publishes optimistically (the same status record that would
     *  confirm it also arrives on its own from the appliance's regular chatter, same as MI2D7B.ts/
     *  RD20_S.ts's unreadable echoes elsewhere - not treated as the source of truth here either,
     *  to keep this in step with `power`'s own optimistic publish). */
    private setSetting(
        prop: string,
        field: 'endMelody' | 'airFilterReminder' | 'washCompleteLight' | 'timeDisplay' | 'autoSelect' | 'coolDry',
        on: boolean,
    ) {
        const record = this.lastRecord
        if (!record) {
            log('status', `${this.id}: ${prop} set before any status record was seen - not sent`)
            return
        }
        const settingsA = record[REC_SETTINGS_A]
        const dry = record[REC_DRY]
        const settingsB = record[REC_SETTINGS_B]

        const current = {
            autoSelect: (settingsA & SETTINGS_A_AUTO_SELECT) !== 0,
            washCompleteLight: (settingsA & SETTINGS_A_WASH_COMPLETE_LIGHT) !== 0,
            timeDisplay: (dry & DRY_TIME_DISPLAY_BIT) !== 0,
            coolDry: (settingsB & SETTINGS_B_COOL_DRY) !== 0,
            endMelody: (settingsB & SETTINGS_B_END_MELODY) !== 0,
            airFilterReminder: (settingsB & SETTINGS_B_AIR_FILTER_REMINDER) !== 0,
        }
        current[field] = on

        const byte4 =
            (current.washCompleteLight ? WRITE_WASH_COMPLETE_LIGHT : 0) |
            (current.timeDisplay ? WRITE_TIME_DISPLAY : 0) |
            (current.autoSelect ? WRITE_AUTO_SELECT : 0) |
            (current.endMelody ? WRITE_END_MELODY : 0) |
            (current.coolDry ? WRITE_COOL_DRY : 0)
        const byte5 = (current.airFilterReminder ? WRITE_AIR_FILTER_REMINDER : 0) | WRITE_BYTE5_UNKNOWN_BIT

        this.send(buildSettingsWrite(byte4, byte5))
        this.publishProperty(prop, on ? 'ON' : 'OFF')
    }

    /** Publishes everything decoded from one 26-byte status record - see the file header's STATUS
     *  RECORD section for what each offset means. */
    private publishRecord(record: Buffer) {
        this.lastRecord = record

        const on = record[REC_POWER] === 0x01
        if (on !== this.power) {
            this.power = on
            this.publishProperty('power', on ? 'ON' : 'OFF')
        }

        this.publishProperty('duration_minutes', record[REC_HOURS] * 60 + record[REC_MINUTES])
        this.publishProperty('course_index', record[REC_COURSE_INDEX])
        this.publishProperty('reservation_hours', record[REC_RESERVATION_HOURS])

        const opts = record[REC_OPTIONS]
        this.publishProperty('steam', opts & OPT_STEAM ? 'ON' : 'OFF')
        this.publishProperty('intensive_wash_top', opts & OPT_INTENSIVE_TOP ? 'ON' : 'OFF')
        this.publishProperty('intensive_wash_bottom', opts & OPT_INTENSIVE_BOTTOM ? 'ON' : 'OFF')
        this.publishProperty('high_temp_sterilize', opts & OPT_HIGH_TEMP_STERILIZE ? 'ON' : 'OFF')

        const dry = record[REC_DRY]
        this.publishProperty('extra_rinse', dry & DRY_EXTRA_RINSE_BIT ? 'ON' : 'OFF')
        this.publishProperty('hot_air_dry_minutes', DRY_TIER_MINUTES[(dry >> 4) & 0x03])
        this.publishProperty('time_display', dry & DRY_TIME_DISPLAY_BIT ? 'ON' : 'OFF')

        const settingsA = record[REC_SETTINGS_A]
        this.publishProperty('auto_select', settingsA & SETTINGS_A_AUTO_SELECT ? 'ON' : 'OFF')
        this.publishProperty('wash_complete_light', settingsA & SETTINGS_A_WASH_COMPLETE_LIGHT ? 'ON' : 'OFF')

        const settingsB = record[REC_SETTINGS_B]
        this.publishProperty('cool_dry', settingsB & SETTINGS_B_COOL_DRY ? 'ON' : 'OFF')
        this.publishProperty('end_melody', settingsB & SETTINGS_B_END_MELODY ? 'ON' : 'OFF')
        this.publishProperty('air_filter_reminder', settingsB & SETTINGS_B_AIR_FILTER_REMINDER ? 'ON' : 'OFF')
    }

    processAABB(buf: Buffer) {
        // ack: <sub=0x32> 00 26 00  (4 bytes) - nothing to publish, just confirms the write landed
        if (buf.length === 4 && buf[0] === ACK_SUB && buf[1] === 0x00 && buf[2] === ACK_OPCODE && buf[3] === 0x00)
            return

        // 0xEC dual-record status frame - the "new" (current) record is the second half, right
        // after the "old" one. See the file header's STATUS RECORD section.
        if (buf[0] === ACK_SUB && buf[1] === STATUS_TYPE && buf.length === 2 + 2 * RECORD_LEN) {
            this.publishRecord(buf.subarray(2 + RECORD_LEN, 2 + 2 * RECORD_LEN))
            return
        }

        // 0xEB single-record response to QUERY_FRAME - same record shape, only one copy.
        if (buf[0] === ACK_SUB && buf[1] === 0xeb && buf.length === STATUS_MIN_LEN) {
            this.publishRecord(buf.subarray(2, STATUS_MIN_LEN))
            return
        }

        // Anything else is a frame this handler does not parse yet (the course-name table, etc).
        // Note it once per shape so a future session has something to grep for, the same way
        // TLVDevice.noteUnknownTags does for the AC family.
        const key = buf.length > 0 ? `${buf.length}:${buf[0].toString(16)}:${(buf[1] ?? 0).toString(16)}` : 'empty'
        if (!this.seenUnknown.has(key)) {
            this.seenUnknown.add(key)
            log('status', this.id, `H01: unrecognised frame shape (len=${buf.length}, buf[0..1]=${key})`)
            recordNote(this.id, this.thinq.meta, 'unmodelled-aabb-frame', { len: buf.length, head: key })
        }
    }
}
