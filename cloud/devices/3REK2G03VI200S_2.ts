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
 * LG kimchi fridge (김치냉장고), ThinQ model 3REK2G03VI200S_2, a 3-compartment unit (상칸/중칸/하칸
 * - "top/middle/bottom"). Shares the AA..BB envelope with the rest of this fork's AABB-family
 * handlers, but its own opcode sub-byte is `0x11` (2REF21EBNSX_3's fridge uses `0x10`) - a
 * different physical protocol family under the same envelope, not the same device with a
 * different model string.
 *
 * Everything below was captured live 2026-09-10 by driving my.lgthinq.com directly (Playwright)
 * against the real unit, one compartment/option at a time, and reading rethink's on-box capture
 * log for the same timestamps - the same method used throughout this fork. Compartment storage
 * modes were swept exhaustively (every option in every compartment's own menu); the door/dedorize
 * bits were isolated the same way the fridge's own door-by-compartment finding was.
 *
 * QUERY: byte-for-byte the same frame 2REF21EBNSX_3.ts already uses (this fork's rethink
 * apparently reuses one fixed query frame across this whole GGM-20 fridge family):
 *
 *   to-device   aa 0e f0 ed 12 11 01 00 00 01 04 00 <ck> bb             (fixed, no parameters)
 *   from-device aa 10 11 eb <10-byte record, see RECORD_* offsets> <ck> bb
 *
 * WRITE: a single positional frame, one compartment/option per write - unlike 2REF21EBNSX_3's
 * "many settings in one 43-byte frame" style, this model's write only ever carries one change:
 *
 *   to-device   aa 0f f0 e5 00 02 01 ff 01 00 <byteIndex> 00 <value> <ck> bb
 *   from-device aa 07 11 00 e5 <ck> bb                                        (ack, 3-byte body)
 *   from-device aa 18 11 e6 00 02 01 ff 01 00 <byteIndex> 00 <value> <10-byte record> <ck> bb
 *
 * The write's selector byte is simply the target field's own byte index into the 10-byte state
 * record below - confirmed across all 4 writable fields (RECORD_TOP=1, RECORD_MIDDLE=3,
 * RECORD_BOTTOM=4, RECORD_ONE_TOUCH_DEODORIZE=6), so building a write needs no separate lookup
 * table. The `e6` echo's trailing 10 bytes look like a state record but are NOT the new one -
 * confirmed live: right after a 중칸 write, its embedded record[3] still read the OLD value, not
 * the one just written, and a 하칸 write's own echo carried 중칸's already-applied change from an
 * *earlier* write but its own field still at the old value too. It appears to snapshot whatever
 * was true right before this particular write landed, not after - recognised by shape and
 * silently dropped rather than applied as state (see processAABB); the real update always arrives
 * moments later as a proper `ec` push anyway.
 *
 * STATE: byte-for-byte the same old/new record-pair convention every other AABB fridge-family
 * handler in this fork uses:
 *
 *   from-device aa 1a 11 ec <old 10-byte record><new 10-byte record> <ck> bb
 *
 * 10-byte record layout (offsets confirmed by sweeping every compartment through its own full
 * menu and diffing before/after - see RECORD_TOP_MODE_NAMES etc. below for the per-compartment
 * value tables):
 *
 *   record[0]  = 0x02, constant in every capture - not established what this is.
 *   record[1]  = 상칸(top) storage mode - see RECORD_TOP_MODE_NAMES.
 *   record[2]  = 0xff, constant in every capture - modelJSON documents a 4th room, room2Temp
 *                ("right" side, per its own `_comment` field) alongside room1/room3/room4, that
 *                this physical 3-door unit doesn't have; this offset (and record[5], see below) is
 *                most likely that room's slot, permanently "not present" on this unit.
 *   record[3]  = 중칸(middle) storage mode - see RECORD_MIDDLE_MODE_NAMES. Its own menu is
 *                different from 상칸's (no 냉동/냉장 options, has 구입 김치 instead) and the two
 *                compartments don't share a value scheme even where option names overlap - e.g.
 *                맛지킴 김치 (중/강/약) happen to be 0/1/2 in both, but that's the only overlap.
 *   record[4]  = 하칸(bottom) storage mode - see RECORD_BOTTOM_MODE_NAMES. A third, again
 *                different menu (no 냉동/냉장/구입김치/유산균+/익힘 - has 육류/생선 and 오래 보관
 *                instead).
 *   record[5]  = 0xff, constant - see record[2].
 *   record[6]  = 원터치 탈취(one-touch deodorize), 0x00 off / 0x01 on. The appliance describes
 *                this in-app as self-limiting ("탈취가 완료되면 자동으로 꺼져요") - confirmed live
 *                that toggling it on and back off both reach the device.
 *   record[7]  = 상칸-specific "closed" flag, 1=closed / 0=open - confirmed live: opening/closing
 *                상칸's door flips this, opening/closing 중칸 or 하칸's door does NOT move it at
 *                all. Unlike 2REF21EBNSX_3, only 상칸 gets an individual flag here - 중칸/하칸
 *                have no bit of their own in this record, only the aggregate below.
 *   record[8]  = aggregate "at least one door open", 0=all closed / 1=at least one open -
 *                confirmed live for all three compartments (each one's door event flips this).
 *   record[9]  = 0x01, constant in every capture - not established what this is.
 *
 * Per-compartment storage modes confirmed live (2026-09-10, every option in each compartment's
 * own menu, one at a time, via the appliance's own confirm dialog - "식품이 상하지 않도록
 * 주의하세요. 온도(모드)를 바꿀까요?"). A first pass of this sweep missed several options; the
 * modelJSON cross-check below (fetched via rethink's `/bridge/<id>/modeljson`, see RETHINK
 * memory) named them and gave byte values, and the owner then pressed every one of them from the
 * panel directly (2026-09-15) to confirm both the byte and the on-screen Korean text - nothing
 * in the tables below is modelJSON-only anymore:
 *
 *   - 상칸's own live-tested "냉장" submenu was mislabelled 상/중/약; modelJSON's `room1Temp_C`
 *     enum (index 3/4/5, label keys FRIDGE#MIDDLE/STRONG/WEAK) said 중/강/약 instead - the same
 *     중/강/약 pattern already used correctly everywhere else in this file. Corrected.
 *   - 중칸/하칸 both have an entire submenu modelJSON documents (`room3Temp_C`/`room4Temp_C` index
 *     3/4/5, label key VEGI_FRUIT#MIDDLE/STRONG/WEAK, "야채·과일") that the first sweep never
 *     triggered - 0x03/0x04/0x05 on both, now pressed one at a time on the real unit.
 *   - 하칸 also has a `room4Temp_C` index 6 (label key RICE_GRAIN, "쌀·잡곡") the first sweep
 *     missed - 0x06, likewise pressed live.
 *   - 꺼짐(off) exists on all three compartments, found live 2026-09-15 (not in modelJSON at all -
 *     this one was never a documented option, just discovered by pressing it): 0x09 상칸, 0x0d
 *     중칸, 0x09 하칸 - three different codes, not a shared "off" value, matching every other case
 *     in these tables where 상칸/중칸/하칸 don't share a scheme. Turning 중/하칸 off was also seen
 *     to flip 상칸 back to 냉동 as a real appliance interlock, not something modelled here (see
 *     RECORD_TOP_MODE_NAMES' own comment).
 *
 *   상칸(top):    맛지킴 김치 (중)=0x00, (강)=0x01, (약)=0x02, 냉장 (중)=0x03, 냉장 (강)=0x04,
 *                 냉장 (약)=0x05, 냉동=0x06, 익힘=0x07, 꺼짐=0x09, 유산균 김치+=0x0a
 *   중칸(middle): 맛지킴 김치 (중)=0x00, (강)=0x01, (약)=0x02, 야채·과일 (중)=0x03, (강)=0x04,
 *                 (약)=0x05, 구입 김치=0x06, 유산균 김치+=0x07, 익힘=0x0b, 꺼짐=0x0d
 *   하칸(bottom): 맛지킴 김치 (중)=0x00, (강)=0x01, (약)=0x02, 야채·과일 (중)=0x03, (강)=0x04,
 *                 (약)=0x05, 쌀·잡곡=0x06, 육류/생선=0x07, 오래 보관=0x08, 꺼짐=0x09
 *
 *   modelJSON also confirms the room<->compartment mapping this file already assumed:
 *   `roomConfig` maps room1Temp="@KM_TOP_ROOM_W", room3Temp="@KM_MIDDLE_ROOM_W",
 *   room4Temp="@KM_BOTTOM_ROOM_W" - i.e. record[1]/record[3]/record[4] (this unit skips room2,
 *   the right-side room a 3-door unit doesn't have - see record[2] below, not room4 as an earlier
 *   draft of this comment guessed before the modelJSON was cross-checked).
 *
 * Baseline confirmed against the real unit's own device page: 상칸=냉동, 중칸=맛지킴 김치 (중),
 * 하칸=맛지킴 김치 (중), 원터치 탈취=off - all three compartments restored to this after testing.
 *
 * ENERGY COUNTER (decoded 2026-09-11): the `11 3e` frame previously logged as "a plain periodic
 * tick, not energy-related" turned out to be exactly that - it was mistaken for a bare uptime
 * counter after only 3 occurrences with nothing to compare the growing byte against. Mining a
 * day and a half of it from the frame log (130 occurrences) instead of live-testing showed:
 *
 *   from-device  aa 0b 11 3e 00 <delta> <total_hi> <total_lo> <tick> <ck> bb
 *
 * `<delta>` is the Wh added since the previous report and `<total_hi>/<total_lo>` (big-endian
 * u16) is a running total that `<delta>` always adds onto exactly - e.g. total 246 followed by
 * delta 16 next report gives total 262, confirmed additive across all 130 samples with zero
 * exceptions. `<tick>` just increments by 1 every ~15 minutes (the original, correct half of the
 * old reading) and is not published. The total does not reset at local midnight (values climb
 * straight through the KST day boundary in the log) but does reset somewhere else in the day
 * (330 late on 2026-09-10 down to 134 the next afternoon, outside any midnight the log covers) -
 * almost certainly the same "resets whenever the bridge's cloud session is refreshed, not on a
 * calendar boundary" behaviour 2REF21EBNSX_3.ts's own `10 af` counter has, not a daily meter.
 * Published as a bare `total_increasing` counter for exactly that reason - see 2REF21EBNSX_3.ts's
 * own `energy_raw_counter` for the identical caveat and why the unit (presumably Wh, not
 * independently calibrated against the app's own kWh figure to the same precision the fridge's
 * counter was) is left off rather than asserted.
 *
 * UNIT CONFIRMED (2026-09-12): this model's own app screen exposes an hourly Wh breakdown (most
 * models this fork has seen so far only get a monthly total), so `<delta>` could be checked
 * directly against real figures instead of the fridge's own once-a-day total. Summing `<delta>`
 * samples that fall within the same clock hour and comparing to the app's per-hour Wh value for
 * 2026-09-12: 02:00 matched exactly (41 computed, 41 shown), 03:00 was 42 vs 40, other hours ±2 -
 * consistent with Wh and with the small mismatch being the ~15-minute sample cadence not lining up
 * with the clock-hour boundary, not a wrong scale. `<delta>` now feeds `energy-accumulator.ts` (see
 * FX___S.ts for the same module used the same way) for hour/day/month/total figures that survive
 * the running total's own unpredictable resets; the raw counter above is kept as-is alongside it.
 *
 * NOT YET DECODED, left deliberately unmodelled:
 *   - `11 31` (51 bytes): fires rarely, contains two readable ASCII part/serial-number-looking
 *     strings (e.g. "SAA42276301") - an identification/inventory block, not live state. Recognised
 *     by shape and silently dropped (see processAABB) rather than re-flagged every time, the same
 *     way 2REF21EBNSX_3.ts drops its own periodic full-status dump.
 *   - room2Temp (the one modelJSON field with no corresponding physical compartment on this unit -
 *     see record[2]/record[5] above).
 *
 * NOTIFICATION (decoded 2026-09-14): found while looking for this model's equivalent of
 * FX___S.ts's `notification` event entity, which the official `lg_thinq` integration exposes for
 * this fridge too (`event.gimcinaengjanggo_notification`) but this handler had never attempted.
 * `11 72 <13-byte payload>` (15 bytes total) - the opcode number `0x72` matches FX___S's own
 * `MSG_NOTIFY` exactly (different device family, same envelope, same convention for "this is the
 * notify channel"), and `payload[0] === 0` in the one real sample caught so far matches the same
 * gate FX___S's `processNotification` uses. Only one raw sample exists (`payload[1] = 23`, caught
 * incidentally during an unrelated option-write test, not against a deliberately caused event) -
 * but naming it did not need a second sample: the official integration's own
 * `event.gimcinaengjanggo_notification` entity declares its `event_types` as the single-element
 * list `["door_is_open"]` for this exact model (checked live via `GET .../states/<entity_id>`) -
 * this fridge has no filter, and no notification of any other kind is possible for it - so the one
 * code caught is `door_is_open` by elimination, not by matching a second sample. The equivalent
 * entity for 2REF21EBNSX_3.ts's fridge (`event.naengjanggo_notification`) declares six possible
 * types (`door_is_open`, `time_to_change_filter`, `filter_reset_complete`,
 * `water_filter_reset_complete`, `frozen_is_complete`, `time_to_change_water_filter`) - nowhere
 * near as clean an elimination, and moot anyway since the same opcode was searched for in
 * 2REF21EBNSX_3.ts's own logs and never once appeared there - that model's notification channel,
 * if it has one, is still completely unlocated.
 *
 * See RETHINK memory `rethink_migration_status` for the raw capture log this was built from.
 */

const ACK_SUB = 0x11
const ACK_OPCODE = 0xe5

const STATE_SUB = 0x11
const STATE_OPCODE = 0xec
const STATE_RECORD_LEN = 10

const QUERY_SUB = 0x11
const QUERY_OPCODE = 0xeb
/** Fixed, parameterless - byte-for-byte the same frame 2REF21EBNSX_3.ts uses for its own query. */
const QUERY_FRAME = Buffer.from('f0ed1211010000010400', 'hex')
const QUERY_INTERVAL_MS = 5 * 60 * 1000

const WRITE_ECHO_SUB = 0x11
const WRITE_ECHO_OPCODE = 0xe6

/** See the file header's NOTIFICATION section. `NOTIFICATION`'s naming (by elimination, not by a
 *  second matched sample) mirrors the official integration's own single declared event_type for
 *  this model. */
const NOTIFY_SUB = 0x11
const NOTIFY_OPCODE = 0x72
const NOTIFY_FRAME_LEN = 15
const NOTIFY_CODE_OFFSET = 3
const NOTIFICATION: Record<number, string> = {
    23: 'door_is_open',
}
const NOTIFICATION_OPTIONS = [...new Set(Object.values(NOTIFICATION))]

/** See the file header's ENERGY COUNTER section. */
const ENERGY_SUB = 0x11
const ENERGY_OPCODE = 0x3e
const ENERGY_FRAME_LEN = 7
const ENERGY_DELTA_OFFSET = 3
const ENERGY_TOTAL_OFFSET = 4
/** `f0 e5 00 02 01 ff 01 00` - constant across every write captured; only the selector (= the
 *  target's own record byte index) and the value after it ever change. */
const WRITE_HEADER = Buffer.from('f0e5000201ff0100', 'hex')

const RECORD_TOP = 1
const RECORD_MIDDLE = 3
const RECORD_BOTTOM = 4
const RECORD_ONE_TOUCH_DEODORIZE = 6
const RECORD_TOP_DOOR_CLOSED = 7
const RECORD_ANY_DOOR_OPEN = 8

/*
 * "꺼짐"(off), added 2026-09-15 - confirmed live, all three compartments switched off from the
 * panel in one sitting (상칸 first, then 중/하칸 together). Each compartment's own off code, not
 * a shared one, matching the rest of these tables already being three separate vocabularies:
 * 0x09 for 상칸, 0x0d for 중칸, 0x09 for 하칸 (상칸 and 하칸 sharing a raw value is coincidence,
 * not a sign the two share a menu - see the file header on why they don't).
 *
 * Turning 중/하칸 off was also seen to flip 상칸 from its own 0x09 back to 0x06(냉동) as a side
 * effect, unprompted - a real appliance interlock (confirmed by the owner asking, not assumed),
 * not a transient read caught mid-navigation. Not modelled here: this table says what a value
 * means, not when the appliance changes it out from under you.
 */
/** record[RECORD_TOP] values - see the file header for how these were confirmed. */
const RECORD_TOP_MODE_NAMES: Record<number, string> = {
    0x00: '맛지킴 김치 (중)',
    0x01: '맛지킴 김치 (강)',
    0x02: '맛지킴 김치 (약)',
    0x03: '냉장 (중)',
    0x04: '냉장 (강)',
    0x05: '냉장 (약)',
    0x06: '냉동',
    0x07: '익힘',
    0x09: '꺼짐',
    0x0a: '유산균 김치+',
}
/** record[RECORD_MIDDLE] values - a different menu than 상칸's (see the file header). */
const RECORD_MIDDLE_MODE_NAMES: Record<number, string> = {
    0x00: '맛지킴 김치 (중)',
    0x01: '맛지킴 김치 (강)',
    0x02: '맛지킴 김치 (약)',
    0x03: '야채·과일 (중)',
    0x04: '야채·과일 (강)',
    0x05: '야채·과일 (약)',
    0x06: '구입 김치',
    0x07: '유산균 김치+',
    0x0b: '익힘',
    0x0d: '꺼짐',
}
/** record[RECORD_BOTTOM] values - a third, again different menu (see the file header). */
const RECORD_BOTTOM_MODE_NAMES: Record<number, string> = {
    0x00: '맛지킴 김치 (중)',
    0x01: '맛지킴 김치 (강)',
    0x02: '맛지킴 김치 (약)',
    0x03: '야채·과일 (중)',
    0x04: '야채·과일 (강)',
    0x05: '야채·과일 (약)',
    0x06: '쌀·잡곡',
    0x07: '육류/생선',
    0x08: '오래 보관',
    0x09: '꺼짐',
}

function decodeMode(names: Record<number, string>, raw: number): string {
    return names[raw] ?? `unknown_${raw}`
}

/** Reverse lookup for setProperty - the exact Korean label HA sends back must be one of this
 *  compartment's own known options, since the select entity only ever offers those. */
function encodeMode(names: Record<number, string>, label: string): number | undefined {
    for (const [raw, name] of Object.entries(names)) {
        if (name === label) return Number(raw)
    }
    return undefined
}

function buildWrite(byteIndex: number, value: number): Buffer {
    return Buffer.concat([WRITE_HEADER, Buffer.from([byteIndex, 0x00, value])])
}

export default class Device extends AABBDevice {
    topMode: string | undefined
    middleMode: string | undefined
    bottomMode: string | undefined
    oneTouchDeodorize: boolean | undefined
    topDoorOpen: boolean | undefined
    anyDoorOpen: boolean | undefined
    energyTotal: number | undefined

    /** (dir:tag) pairs already flagged as unrecognised, so a repeating one is noted once. */
    private seenUnknown = new Set<string>()
    private queryTimer: ReturnType<typeof setInterval> | undefined
    private energy: energyAccumulator.EnergyTracker | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta),
            components: {
                top_compartment: {
                    platform: 'select',
                    unique_id: '$deviceid-top_compartment',
                    name: 'Top compartment',
                    icon: 'mdi:fridge-top',
                    options: Object.values(RECORD_TOP_MODE_NAMES),
                    state_topic: '$this/top_compartment',
                    command_topic: '$this/top_compartment/set',
                },
                middle_compartment: {
                    platform: 'select',
                    unique_id: '$deviceid-middle_compartment',
                    name: 'Middle compartment',
                    icon: 'mdi:fridge-industrial',
                    options: Object.values(RECORD_MIDDLE_MODE_NAMES),
                    state_topic: '$this/middle_compartment',
                    command_topic: '$this/middle_compartment/set',
                },
                bottom_compartment: {
                    platform: 'select',
                    unique_id: '$deviceid-bottom_compartment',
                    name: 'Bottom compartment',
                    icon: 'mdi:fridge-bottom',
                    options: Object.values(RECORD_BOTTOM_MODE_NAMES),
                    state_topic: '$this/bottom_compartment',
                    command_topic: '$this/bottom_compartment/set',
                },
                one_touch_deodorize: {
                    platform: 'switch',
                    unique_id: '$deviceid-one_touch_deodorize',
                    name: 'One-touch deodorize',
                    icon: 'mdi:air-purifier',
                    state_topic: '$this/one_touch_deodorize',
                    command_topic: '$this/one_touch_deodorize/set',
                },
                top_door_open: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-top_door_open',
                    name: 'Top compartment door open',
                    icon: 'mdi:fridge-top',
                    device_class: 'door',
                    state_topic: '$this/top_door_open',
                },
                any_door_open: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-any_door_open',
                    name: 'Any door open',
                    icon: 'mdi:fridge-alert-outline',
                    device_class: 'door',
                    state_topic: '$this/any_door_open',
                },
                // Deliberately no device_class/unit_of_measurement - see the file header's ENERGY
                // COUNTER section for why the scale isn't asserted yet.
                energy_total_counter: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_total_counter',
                    name: 'Energy total counter (unit unconfirmed)',
                    icon: 'mdi:lightning-bolt-outline',
                    state_class: 'total_increasing',
                    state_topic: '$this/energy_total_counter',
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
                // Calendar-boundary Wh figures - see energy-accumulator.ts and the file header's
                // ENERGY COUNTER/UNIT CONFIRMED sections. These survive the raw counter's own
                // unpredictable resets; energy_total is a lifetime total that only grows.
                energy_hour: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_hour',
                    name: 'Energy this hour',
                    icon: 'mdi:lightning-bolt',
                    device_class: 'energy',
                    unit_of_measurement: 'Wh',
                    state_class: 'total',
                    state_topic: '$this/energy_hour',
                },
                energy_day: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_day',
                    name: 'Energy today',
                    icon: 'mdi:lightning-bolt',
                    device_class: 'energy',
                    unit_of_measurement: 'Wh',
                    state_class: 'total',
                    state_topic: '$this/energy_day',
                },
                energy_month: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_month',
                    name: 'Energy this month',
                    icon: 'mdi:lightning-bolt',
                    device_class: 'energy',
                    unit_of_measurement: 'Wh',
                    state_class: 'total',
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
            },
        })

        this.setConfig(config)
        log(
            'status',
            this.id,
            '3REK2G03VI200S_2 (김치냉장고) handler started - per-compartment storage mode + one-touch deodorize + door sensors, see file header',
        )
        // Wired here, not in start(), so a delta reaching processAABB works from construction
        // onward regardless of whether/when start() runs - matches this always having worked
        // that way back when recordEnergyDelta called energyAccumulator.addDelta() directly.
        this.energy = energyAccumulator.attach(this.id, (property, value) => this.publishProperty(property, value))
    }

    start() {
        super.start()
        this.query()
        this.queryTimer = setInterval(() => {
            this.query()
        }, QUERY_INTERVAL_MS)
    }

    cancelPendingWork() {
        clearInterval(this.queryTimer)
        this.queryTimer = undefined
        this.energy?.cancel()
        this.energy = undefined
        super.cancelPendingWork()
    }

    query() {
        this.send(QUERY_FRAME)
    }

    /** Events do not go through publishProperty - not deduped (a repeat of the same event must
     *  still fire) and not retained (an event entity should not replay a stale past occurrence at
     *  every reconnect) - see FX___S.ts's identical method for the full reasoning. */
    publishEvent(topic: string, eventType: string) {
        this.HA.publishProperty(this.id, topic, JSON.stringify({ event_type: eventType }), { retain: false })
    }

    /** Applies a state record (10 bytes) - shared between the `ec` state frame's current half and
     *  the `eb` query response, which are the same layout (the `e6` write echo's own trailing 10
     *  bytes look identical but are NOT a live record - see the file header). */
    private applyStateRecord(record: Buffer) {
        const topMode = decodeMode(RECORD_TOP_MODE_NAMES, record[RECORD_TOP])
        if (topMode !== this.topMode) {
            this.topMode = topMode
            this.publishProperty('top_compartment', topMode)
        }

        const middleMode = decodeMode(RECORD_MIDDLE_MODE_NAMES, record[RECORD_MIDDLE])
        if (middleMode !== this.middleMode) {
            this.middleMode = middleMode
            this.publishProperty('middle_compartment', middleMode)
        }

        const bottomMode = decodeMode(RECORD_BOTTOM_MODE_NAMES, record[RECORD_BOTTOM])
        if (bottomMode !== this.bottomMode) {
            this.bottomMode = bottomMode
            this.publishProperty('bottom_compartment', bottomMode)
        }

        const oneTouchDeodorize = record[RECORD_ONE_TOUCH_DEODORIZE] === 1
        if (oneTouchDeodorize !== this.oneTouchDeodorize) {
            this.oneTouchDeodorize = oneTouchDeodorize
            this.publishProperty('one_touch_deodorize', oneTouchDeodorize ? 'ON' : 'OFF')
        }

        const topDoorOpen = record[RECORD_TOP_DOOR_CLOSED] !== 1
        if (topDoorOpen !== this.topDoorOpen) {
            this.topDoorOpen = topDoorOpen
            this.publishProperty('top_door_open', topDoorOpen ? 'ON' : 'OFF')
        }

        const anyDoorOpen = record[RECORD_ANY_DOOR_OPEN] === 1
        if (anyDoorOpen !== this.anyDoorOpen) {
            this.anyDoorOpen = anyDoorOpen
            this.publishProperty('any_door_open', anyDoorOpen ? 'ON' : 'OFF')
        }
    }

    private setCompartment(names: Record<number, string>, byteIndex: number, label: string) {
        const raw = encodeMode(names, label)
        if (raw === undefined) {
            console.warn(`3REK2G03VI200S_2: unknown compartment mode "${label}"`)
            return
        }
        this.send(buildWrite(byteIndex, raw))
        // Published optimistically for a snappy UI; the real `ec` state frame (or the write's own
        // `e6` echo) that follows corrects this if needed - see the file header.
        this.publishProperty(
            byteIndex === RECORD_TOP
                ? 'top_compartment'
                : byteIndex === RECORD_MIDDLE
                  ? 'middle_compartment'
                  : 'bottom_compartment',
            label,
        )
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'top_compartment':
                this.topMode = mqttValue
                this.setCompartment(RECORD_TOP_MODE_NAMES, RECORD_TOP, mqttValue)
                return
            case 'middle_compartment':
                this.middleMode = mqttValue
                this.setCompartment(RECORD_MIDDLE_MODE_NAMES, RECORD_MIDDLE, mqttValue)
                return
            case 'bottom_compartment':
                this.bottomMode = mqttValue
                this.setCompartment(RECORD_BOTTOM_MODE_NAMES, RECORD_BOTTOM, mqttValue)
                return
            case 'one_touch_deodorize': {
                const on = mqttValue === 'ON'
                this.send(buildWrite(RECORD_ONE_TOUCH_DEODORIZE, on ? 0x01 : 0x00))
                this.oneTouchDeodorize = on
                this.publishProperty('one_touch_deodorize', on ? 'ON' : 'OFF')
                return
            }
            default:
                console.warn(`3REK2G03VI200S_2: attempting to set unknown property ${prop}`)
        }
    }

    processAABB(buf: Buffer) {
        // ack: <sub=0x11> 00 <opcode=0xe5> (3 bytes) - nothing to publish, just confirms the write landed
        if (buf.length === 3 && buf[0] === ACK_SUB && buf[1] === 0x00 && buf[2] === ACK_OPCODE) return

        // state: <sub=0x11> ec <old 10-byte record><new 10-byte record> - see the file header.
        if (buf.length === 2 + 2 * STATE_RECORD_LEN && buf[0] === STATE_SUB && buf[1] === STATE_OPCODE) {
            this.applyStateRecord(buf.subarray(2 + STATE_RECORD_LEN, 2 + 2 * STATE_RECORD_LEN))
            return
        }

        // query response: <sub=0x11> eb <10-byte record> - see the file header.
        if (buf.length === 2 + STATE_RECORD_LEN && buf[0] === QUERY_SUB && buf[1] === QUERY_OPCODE) {
            this.applyStateRecord(buf.subarray(2, 2 + STATE_RECORD_LEN))
            return
        }

        // write echo: <sub=0x11> e6 <8-byte header echo><10 bytes that look like a record but
        // are not a live one - see the file header>. Recognised by shape and silently dropped -
        // the real update always arrives moments later as a proper `ec` push anyway.
        if (buf.length === 2 + 8 + STATE_RECORD_LEN && buf[0] === WRITE_ECHO_SUB && buf[1] === WRITE_ECHO_OPCODE) return

        // energy counter: <sub=0x11> 3e 00 <delta> <total_hi> <total_lo> <tick> - see the file
        // header's ENERGY COUNTER section.
        if (buf.length === ENERGY_FRAME_LEN && buf[0] === ENERGY_SUB && buf[1] === ENERGY_OPCODE) {
            const total = buf.readUInt16BE(ENERGY_TOTAL_OFFSET)
            if (total !== this.energyTotal) {
                this.energyTotal = total
                this.publishProperty('energy_total_counter', total)
            }
            const delta = buf[ENERGY_DELTA_OFFSET]
            if (delta > 0) void this.energy?.recordDelta(delta)
            return
        }

        // notification channel: <sub=0x11> 72 <payload> - see the file header's NOTIFICATION
        // section. Only published when the leading payload byte is 0 (the same gate FX___S.ts
        // uses for its own notify channel) and the code is one this fork can name - an unnamed
        // code is left unpublished rather than guessed at, the same call FX___S.ts's own
        // processNotification makes.
        if (buf.length === NOTIFY_FRAME_LEN && buf[0] === NOTIFY_SUB && buf[1] === NOTIFY_OPCODE && buf[2] === 0) {
            const name = NOTIFICATION[buf[NOTIFY_CODE_OFFSET]]
            if (name !== undefined) this.publishEvent('notification', name)
            return
        }

        // identification block: <sub=0x11> 31 <49 bytes, two ASCII serial/part-number strings> -
        // see the file header's NOT YET DECODED note. Recognised by shape and silently dropped, the
        // same way 2REF21EBNSX_3.ts drops its own periodic full-status dump - it's a fixed
        // inventory block, not live state, so there's nothing to gain from re-flagging it.
        if (buf.length === 51 && buf[0] === 0x11 && buf[1] === 0x31) return

        // Anything else is a frame this handler does not parse yet (`11 3e`, the still-open energy
        // question, among them). Note it once per shape so a future session has something to grep
        // for, the same way TLVDevice.noteUnknownTags does for the AC family.
        const key = buf.length > 0 ? `${buf.length}:${buf[0].toString(16)}:${(buf[1] ?? 0).toString(16)}` : 'empty'
        if (!this.seenUnknown.has(key)) {
            this.seenUnknown.add(key)
            log('status', this.id, `3REK2G03VI200S_2: unrecognised frame shape (len=${buf.length}, buf[0..1]=${key})`)
            recordNote(this.id, this.thinq.meta, 'unmodelled-aabb-frame', { len: buf.length, head: key })
        }
    }
}
