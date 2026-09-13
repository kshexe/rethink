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

function buildPowerWrite(on: boolean): Buffer {
    return Buffer.from([0xf0, 0x26, on ? 0x16 : 0x12])
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
            },
        })

        this.setConfig(config)
        log('status', this.id, 'H01 (식기세척기) handler started - see file header for what is decoded')
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
                // Optimistic: see the file header for why this is not read back off the wire.
                this.power = on
                this.publishProperty('power', on ? 'ON' : 'OFF')
                return
            }
            default:
                console.warn(`H01: attempting to set unknown property ${prop}`)
        }
    }

    /** Publishes everything decoded from one 26-byte status record - see the file header's STATUS
     *  RECORD section for what each offset means. */
    private publishRecord(record: Buffer) {
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
