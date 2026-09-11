import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type DeviceDiscovery } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { note as recordNote } from '../frame-recorder'

/*
 * LG fridge (냉장고), ThinQ model 2REF21EBNSX_3.
 *
 * Shares the AA..BB envelope with the rest of this fork's AABB-family handlers. Settings writes
 * on this model are a single fixed-length 43-byte positional frame (`f0 17 <43 bytes, mostly 0xff
 * sentinels>`) - one write covers many settings at once, and 0xff in a slot means "leave this
 * alone". Captured directly against a real unit on 2026-09-10 via my.lgthinq.com (DNAT-redirected
 * to rethink, bridge mode relaying to the real LG cloud), matched to each UI action by timestamp:
 *
 *   to-device   aa 2f f0 17 <43 bytes, see newWriteBody()> <ck> bb
 *   from-device aa 08 10 00 17 00 <ck> bb                                (ack)
 *   from-device aa 2a 10 ec <36 bytes, see READ_* offsets> <ck> bb       (state, follows the ack)
 *
 * Entity/property names below follow this model's own modelJSON (fetched via rethink's bridge
 * mode - `GET /bridge/<id>/modeljson`, LG's own field-name schema for this exact model) rather
 * than names invented for this handler:
 *
 *   fridgeTemp    -> fridge_temp    (already matched)
 *   freezerTemp   -> freezer_temp   (already matched)
 *   expressMode   -> express_mode   (was `express_freeze` - the modelJSON's own comment for this
 *                   field is "Express Fridge, ExpressFreeze, Rapid Freeze", a single tri-state
 *                   covering both compartments' quick modes, not a freezer-only "freeze" toggle -
 *                   the old name mis-described what this actually is)
 *   smartCareV2   -> smart_care_v2  (was `smart_care` - this model's config explicitly reports
 *                   `smartCareVersion: "V2"`, so the plain "smartCare" name in other models' modelJSON
 *                   is a different, older feature - keeping "v2" in the name says this is that one)
 *
 * modelJSON's `expressMode` is documented as three-valued (OFF / EXPRESS_ON / RAPID_ON), but only
 * two wire values were ever captured (0x01/0x02 below) - a third RAPID_ON wire value likely exists
 * and is simply unconfirmed, not ruled out. This handler still only exposes a binary switch.
 *
 * Query: unlike the TLV family (TLVDevice queries its own caps/values on a timer, independent of
 * bridge mode), AABBDevice has no active-query mechanism at all - every AABB handler in this fork
 * so far has been purely reactive. That works by accident for a bridged device (the real cloud's
 * own polling, relayed through, happens to produce state frames we can read), but leaves the
 * entities stuck on "unknown" forever for anything that never changes and is never bridged. The
 * query below closes that gap for this model specifically:
 *
 *   to-device   aa 0e f0 ed 12 11 01 00 00 01 04 00 <ck> bb               (fixed, no parameters)
 *   from-device aa 18 10 eb <18-byte record, same layout as the ec state's current record> <ck> bb
 *
 * Confirmed fixed byte-for-byte across every occurrence in a full day's capture (this handler
 * never sent it - it was relayed through by bridge mode - so it was already known to be safe to
 * replay verbatim), and its response's record decodes with the exact same offsets as the `ec`
 * state frame's current record.
 *
 * Write-side offsets confirmed by sweeping each control through its real range and diffing the
 * frames (offsets counted from the start of the 43-byte body, i.e. byte 0 is the 0xf0 of the
 * opcode):
 *
 *   offset 3   fridgeTemp setpoint, raw = degC directly (confirmed 1, 4, 7)
 *   offset 4   freezerTemp setpoint, raw = -14 - degC   (confirmed -23->9, -18->4, -15->1)
 *   offset 5   expressMode, 0x01 = off, 0x02 = on (see modelJSON note above re: a third value)
 *   offset 10  0x01 whenever offset 3 or 4 is being written, 0xff (untouched) otherwise - copied
 *              verbatim from the real captures; what it actually means is not established
 *   offset 19  smartCareV2 master switch, 0x01 = on. Turning it off in the app sent TWO separate
 *              writes - this one at 0x00, and a second frame with offset 6 = 0x06 - while turning
 *              it back on sent only the first (offset 19 = 0x01, offset 6 untouched at 0xff). Both
 *              writes are replayed on OFF, matching the app exactly; only the first is needed for
 *              ON. What offset 6 = 0x06 specifically means is not established (Smart Care+ is a
 *              bundle over three sub-features - it may pin one of them rather than being part of
 *              the on/off state itself), so nothing here writes offset 6 on its own or reads it
 *              back.
 *
 * Read-side: every write's ack is followed by a `10 ec` frame carrying two back-to-back 18-byte
 * records - the value just replaced, then the value now in effect (confirmed against all 8 sweep
 * captures plus the smartCareV2 toggle: the "before" record of each write byte-for-byte matches
 * the "after" record of the write that preceded it). Only the second (current) record is read
 * here:
 *
 *   record[1]   fridgeTemp setpoint, raw = degC directly
 *   record[2]   freezerTemp setpoint, raw = -14 - degC
 *   record[3]   expressMode, 0x01 = off, 0x02 = on
 *   record[7]   door open, 0x01 = at least one door open (see DOOR OPEN below)
 *   record[17]  smartCareV2 master switch, 0x00 = off, 0x01 = on (see SMART CARE V2 below)
 *
 * SMART CARE V2 - corrected 2026-09-10: this was first read off record[4] (0x02 off / 0x07 on -
 * flipped in both directions right alongside every real Smart Care+ toggle, so the *position* was
 * right about correlating with the feature). The upstream `anszom/rethink` project (this fork's
 * origin) ships other 2RE*-prefixed fridge models built on a shared `fridge_common.ts` whose
 * `STATUS_FIELDS` names this same 18-slot record positionally - record[17] there is documented
 * `smartCare // 0=off 1=on`, a plain boolean unlike record[4]'s 2/7 pair. Re-checking this unit's
 * own real captures against record[17] specifically (not just eyeballing which byte moved) found
 * it flips exactly 0->1 on and 1->0 off, in the same two capture pairs used to find record[4] -
 * a cleaner match to a documented value scheme than a coincidentally-correlated byte. record[4]
 * most likely tracks one of Smart Care+'s three bundled sub-features (fridge_common.ts's own
 * adjacent field name there is `freshAirFilter`, matching "AI 신선 케어" from the feature bundle
 * the user originally described) rather than the master switch - plausible, but no sibling model's
 * source actually reads that field either, so it is left unexposed rather than guessed twice.
 *
 * DOOR OPEN - added 2026-09-10, same cross-reference: fridge_common.ts documents record[7] as
 * `anyDoorOpen // 0=closed 1=open 2=closed!` - a deliberate 3-value quirk, not a plain boolean -
 * and every sibling model's own handler checks `=== 1` specifically for "open" rather than
 * treating anything nonzero as open, which this handler copies. Not exposed as its own entity
 * (removed 2026-09-10, once DOOR OPEN BY COMPARTMENT below gave strictly more detail and made a
 * generic "some door is open" redundant) - kept only as applyStateRecord()'s fallback to correct
 * fridge_door_open/freezer_door_open to closed, see there.
 *
 * DOOR OPEN BY COMPARTMENT - confirmed live the same day, in a separate frame family entirely: a
 * from-device `aa 08 10 a8 <compartment> <state> <ck> bb` fires on every individual door open/
 * close, where `<compartment>` is `0x01` for the fridge section or `0x02` for the freezer section
 * and `<state>` is `0x01`/`0x00`. This is NOT one sensor per physical door - the unit has 4 doors
 * (fridge left/right, freezer left/right) but only 2 electrically distinct signals, one per
 * compartment, shared by both doors on that side. Confirmed with 4 separate isolated real open/
 * close tests, live, one door at a time: 냉동 오른쪽 -> `0x02`, 냉장 왼쪽 -> `0x01` (twice,
 * including one ~6-minute-long open that triggered the appliance's own "door open too long" chime
 * 11 times with no change in the reported compartment), 냉동 왼쪽 -> `0x02`. An earlier attempt to
 * read this as "door index 1/2" (one sensor per physical door) produced contradictory results
 * across repeated tests - dropped once the compartment-based reading explained every sample
 * cleanly instead.
 *
 * This event frame is the ONLY source for fridge_door_open/freezer_door_open - unlike every other
 * entity here, they are not part of the regular `10 ec`/`10 eb` state record, so a fresh restart
 * (or a poll with no door event since) leaves them "unknown" in HA until an actual door open/close
 * happens. applyStateRecord() partially covers this: whenever record[7] (anyDoorOpen, above) reads
 * closed, both compartments are certainly closed too, so both get corrected to OFF from there -
 * but when it reads open, which compartment is responsible still isn't knowable without an actual
 * `a8` event, so neither is touched.
 *
 * The remaining bytes of both records (0,5,6,8-16) never changed across a full day's captures, so
 * they are read but not asserted on - see the note above 0x39 (57, the food-poisoning-index shown
 * on the Smart Care+ / 스마트 안심 보관 page) not appearing anywhere in this record, nor as any
 * field in modelJSON's MonitoringValue table at all: that value is described in the app as
 * computed from temperature *and* humidity, so it is derived cloud-side rather than transmitted
 * as a single number by the appliance, and was not pursued further. This frame is what actually
 * keeps the entities below in sync - `setProperty` also publishes optimistically first, for a
 * snappy UI, but this real reading is what corrects it if anything else (the appliance's own
 * panel, the LG app, ...) changes a setting instead.
 *
 * ENERGY COUNTER - found 2026-09-11, not by capturing anything new but by reading another rethink
 * fork's (github.com/plplaaa2/rethink) independently-reverse-engineered `2RES2VE300UA2.ts`, which
 * documents a `10 af` frame carrying a live interval energy reading on that (different) fridge
 * model, and then re-checking this unit's own already-recorded capture log for the same frame -
 * it was there the whole time, just never recognised (logged 11 times as an unmodelled-aabb-frame
 * note over one day, back when this file's own "NOT YET DECODED" list still said the app's energy
 * figure had no candidate byte at all - that note below is now stale, kept only as a marker of how
 * this was found):
 *
 *   from-device aa 0b 10 af <byte, wide-ranging - not established> 00 <hi> 04 04 <ck> bb
 *
 * i.e. a 7-byte AABB body `10 af <?> 00 <hi> 04 04`, where big-endian bytes 3-4 (`00 <hi>`, i.e.
 * `record[3]*256 + record[4]`) read as a plain counter that only ever goes up - confirmed over a
 * real 29-hour span of this unit's own capture log (2026-09-09T18:17Z through 2026-09-10T23:03Z):
 * it climbs from 7 to 87 and never once drops or resets in that whole window, including across the
 * unit's own local (Asia/Seoul) midnight boundary (UTC 15:00) - so unlike plplaaa2's model, this
 * is NOT a per-interval delta that resets each report; whatever it counts, it counts cumulatively.
 * Byte 2 (the `<?>` above) climbs independently of the counter itself early in the capture (0x0f,
 * 0x10, 0x1e, 0x1f, ... up to 0xfa) then gets stuck at 0xfa for the rest of the window while the
 * counter keeps climbing regardless - not established what byte 2 is separately tracking, and not
 * needed to read the counter itself, so processAABB below doesn't gate on it the way plplaaa2's
 * own handler does (`buf[2] === 0x0f || buf[2] === 0x10` - too narrow against this unit's own data,
 * which reaches values neither of those cover almost immediately).
 *
 * UNIT NOT CONFIRMED - published as a bare monotonically-increasing counter (`energy_raw_counter`,
 * `state_class: total_increasing`, no `device_class`/`unit_of_measurement` yet), deliberately not
 * labelled Wh or wired into HA's Energy dashboard yet: comparing this counter's rise across
 * 2026-09-10's own local calendar day (~59-66 units, by the two capture windows nearest to that
 * day's KST midnight boundaries) against the app's own confirmed total for that exact day (141 Wh -
 * see RETHINK memory `rethink_migration_status`) doesn't cleanly match 1:1 as Wh - roughly a factor
 * of ~2 off, unexplained so far (a ×2 scale factor, a different 2-byte window, or byte 2 mattering
 * after all are all still open possibilities). The hourly app-value logger set up in that same
 * memory entry keeps collecting real daily totals going forward specifically so this can be solved
 * empirically once more paired (raw counter delta, real day total) samples exist, rather than
 * guessed from one day's data.
 *
 * NOT YET DECODED, left deliberately unmodelled:
 *   - smartCareV2's three sub-features individually (스마트 안심 보관/AI 신선 케어/에너지 절약
 *     모드) - only the master switch above is exposed; record[4] is a plausible but unconfirmed
 *     candidate for one of them (see above).
 *   - modelJSON also documents a `convertibleTemp` compartment this unit's Info doesn't advertise
 *     - likely does not apply to this physical unit at all.
 *   - the periodic ~5-minute full status dump (`10 cf`, 250 bytes) - looked at for the
 *     food-poisoning-index (see above) and otherwise not investigated further. Recognised in
 *     processAABB (by shape only) and silently dropped, so it no longer trips the generic
 *     unmodelled-frame note every cycle - see the comment there.
 *
 * See RETHINK memory `rethink_migration_status` for the raw capture log this was built from.
 */

const ACK_SUB = 0x10
const ACK_OPCODE = 0x17

const OFFSET_FRIDGE_TEMP = 3
const OFFSET_FREEZER_TEMP = 4
const OFFSET_EXPRESS_MODE = 5
const OFFSET_APPLY_FLAG = 10
const OFFSET_SMART_CARE_V2 = 19
/** Only ever sent alongside offset 19 = 0x00 when turning Smart Care+ off - see the file header. */
const OFFSET_SMART_CARE_V2_OFF_EXTRA = 6

const STATE_SUB = 0x10
const STATE_OPCODE = 0xec
const STATE_RECORD_LEN = 18
/** Offsets within a state record (18 bytes - the current half of an `ec` pair, or the sole
 *  record an `eb` query response carries). */
const RECORD_FRIDGE_TEMP = 1
const RECORD_FREEZER_TEMP = 2
const RECORD_EXPRESS_MODE = 3
const RECORD_DOOR_OPEN = 7
const RECORD_SMART_CARE_V2 = 17

const QUERY_SUB = 0x10
const QUERY_OPCODE = 0xeb
/** Fixed, parameterless - see the file header. */
const QUERY_FRAME = Buffer.from('f0ed1211010000010400', 'hex')
const QUERY_INTERVAL_MS = 5 * 60 * 1000

/** Per-door-open event: `aa 08 10 a8 <compartment> <state> <ck> bb` - see the file header's DOOR
 *  OPEN BY COMPARTMENT section. `buf` here is the 4-byte body AABBDevice hands to processAABB. */
const DOOR_EVENT_SUB = 0x10
const DOOR_EVENT_OPCODE = 0xa8
const DOOR_EVENT_COMPARTMENT_FRIDGE = 0x01
const DOOR_EVENT_COMPARTMENT_FREEZER = 0x02

/** `aa 0b 10 af <?> 00 <hi> 04 04 <ck> bb` - see the file header's ENERGY COUNTER section. */
const ENERGY_SUB = 0x10
const ENERGY_OPCODE = 0xaf
const ENERGY_FRAME_LEN = 7
const ENERGY_COUNTER_HI = 3
const ENERGY_COUNTER_LO = 4

const FRIDGE_TEMP_MIN = 1
const FRIDGE_TEMP_MAX = 7
const FREEZER_TEMP_MIN = -23
const FREEZER_TEMP_MAX = -15

/** The 43-byte body, all-0xff except the opcode header and the fixed tail seen in every real
 *  capture (offsets 23-42) - copied verbatim, its meaning is not established. */
function newWriteBody(): Buffer {
    const body = Buffer.alloc(43, 0xff)
    body[0] = 0xf0
    body[1] = 0x17
    Buffer.from('000000ffff00ffffffff00ffffffffffffffffff', 'hex').copy(body, 23)
    return body
}

function buildFridgeTempWrite(degC: number): Buffer {
    const body = newWriteBody()
    body[OFFSET_FRIDGE_TEMP] = degC
    body[OFFSET_APPLY_FLAG] = 0x01
    return body
}

function buildFreezerTempWrite(degC: number): Buffer {
    const body = newWriteBody()
    body[OFFSET_FREEZER_TEMP] = -14 - degC
    body[OFFSET_APPLY_FLAG] = 0x01
    return body
}

function buildExpressModeWrite(on: boolean): Buffer {
    const body = newWriteBody()
    body[OFFSET_EXPRESS_MODE] = on ? 0x02 : 0x01
    return body
}

/** ON is a single write; OFF is the two-frame sequence the app itself sends - see the file
 *  header for why the second frame (offset 6 = 0x06) is replayed verbatim rather than modelled. */
function buildSmartCareV2Writes(on: boolean): Buffer[] {
    const first = newWriteBody()
    first[OFFSET_SMART_CARE_V2] = on ? 0x01 : 0x00
    if (on) return [first]

    const second = newWriteBody()
    second[OFFSET_SMART_CARE_V2_OFF_EXTRA] = 0x06
    return [first, second]
}

export default class Device extends AABBDevice {
    fridgeTemp: number | undefined
    freezerTemp: number | undefined
    expressMode: boolean | undefined
    fridgeDoorOpen: boolean | undefined
    freezerDoorOpen: boolean | undefined
    smartCareV2: boolean | undefined
    energyRawCounter: number | undefined

    /** (dir:tag) pairs already flagged as unrecognised, so a repeating one is noted once. */
    private seenUnknown = new Set<string>()
    private queryTimer: ReturnType<typeof setInterval> | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta),
            components: {
                fridge_temp: {
                    platform: 'number',
                    unique_id: '$deviceid-fridge_temp',
                    name: 'Fridge temperature',
                    icon: 'mdi:fridge-outline',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    min: FRIDGE_TEMP_MIN,
                    max: FRIDGE_TEMP_MAX,
                    step: 1,
                    mode: 'box',
                    state_topic: '$this/fridge_temp',
                    command_topic: '$this/fridge_temp/set',
                },
                freezer_temp: {
                    platform: 'number',
                    unique_id: '$deviceid-freezer_temp',
                    name: 'Freezer temperature',
                    icon: 'mdi:fridge-industrial-outline',
                    device_class: 'temperature',
                    unit_of_measurement: '°C',
                    min: FREEZER_TEMP_MIN,
                    max: FREEZER_TEMP_MAX,
                    step: 1,
                    mode: 'box',
                    state_topic: '$this/freezer_temp',
                    command_topic: '$this/freezer_temp/set',
                },
                express_mode: {
                    platform: 'switch',
                    unique_id: '$deviceid-express_mode',
                    name: 'Express mode',
                    icon: 'mdi:snowflake',
                    state_topic: '$this/express_mode',
                    command_topic: '$this/express_mode/set',
                },
                smart_care_v2: {
                    platform: 'switch',
                    unique_id: '$deviceid-smart_care_v2',
                    name: 'Smart Care+',
                    icon: 'mdi:shield-check-outline',
                    state_topic: '$this/smart_care_v2',
                    command_topic: '$this/smart_care_v2/set',
                },
                fridge_door_open: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-fridge_door_open',
                    name: 'Fridge door open',
                    icon: 'mdi:fridge-outline',
                    device_class: 'door',
                    state_topic: '$this/fridge_door_open',
                },
                freezer_door_open: {
                    platform: 'binary_sensor',
                    unique_id: '$deviceid-freezer_door_open',
                    name: 'Freezer door open',
                    icon: 'mdi:fridge-industrial-outline',
                    device_class: 'door',
                    state_topic: '$this/freezer_door_open',
                },
                // Deliberately no device_class/unit_of_measurement yet - the scale is unconfirmed,
                // see the file header's ENERGY COUNTER section. state_class alone still lets this
                // be graphed/tracked in HA; wiring it into the Energy dashboard can wait until the
                // scale is actually known, rather than guessing and showing a wrong number there.
                energy_raw_counter: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_raw_counter',
                    name: 'Energy raw counter (unit unconfirmed)',
                    icon: 'mdi:lightning-bolt-outline',
                    state_class: 'total_increasing',
                    state_topic: '$this/energy_raw_counter',
                },
            },
        })

        this.setConfig(config)
        log(
            'status',
            this.id,
            '2REF21EBNSX_3 (냉장고) handler started - fridge/freezer temp + express mode + Smart Care+ only, see file header',
        )
    }

    start() {
        super.start()
        this.query()
        this.queryTimer = setInterval(() => this.query(), QUERY_INTERVAL_MS)
    }

    cancelPendingWork() {
        clearInterval(this.queryTimer)
        this.queryTimer = undefined
        super.cancelPendingWork()
    }

    query() {
        this.send(QUERY_FRAME)
    }

    /** Applies a state record (18 bytes) - shared between the `ec` state frame's current half
     *  and the `eb` query response, which are the same layout. */
    private applyStateRecord(record: Buffer) {
        const fridgeTemp = record[RECORD_FRIDGE_TEMP]
        if (fridgeTemp !== this.fridgeTemp) {
            this.fridgeTemp = fridgeTemp
            this.publishProperty('fridge_temp', fridgeTemp)
        }

        const freezerTemp = -14 - record[RECORD_FREEZER_TEMP]
        if (freezerTemp !== this.freezerTemp) {
            this.freezerTemp = freezerTemp
            this.publishProperty('freezer_temp', freezerTemp)
        }

        const expressMode = record[RECORD_EXPRESS_MODE] === 0x02
        if (expressMode !== this.expressMode) {
            this.expressMode = expressMode
            this.publishProperty('express_mode', expressMode ? 'ON' : 'OFF')
        }

        // record[RECORD_DOOR_OPEN] ("anyDoorOpen") has no per-compartment detail of its own, so it
        // isn't exposed as its own entity (see the file header) - but it's still useful here as a
        // fallback for fridge_door_open/freezer_door_open, which otherwise only ever change from
        // the dedicated per-compartment `a8` door event and so start out (and stay, until a real
        // door event happens) as "unknown" after every restart. When this says nothing is open,
        // both compartments certainly are not either - matches every sibling handler's convention
        // of treating only 1 as open, not "nonzero" (0/2 both mean closed, a documented quirk).
        if (record[RECORD_DOOR_OPEN] !== 1) {
            if (this.fridgeDoorOpen !== false) {
                this.fridgeDoorOpen = false
                this.publishProperty('fridge_door_open', 'OFF')
            }
            if (this.freezerDoorOpen !== false) {
                this.freezerDoorOpen = false
                this.publishProperty('freezer_door_open', 'OFF')
            }
        }

        const smartCareV2 = record[RECORD_SMART_CARE_V2] === 1
        if (smartCareV2 !== this.smartCareV2) {
            this.smartCareV2 = smartCareV2
            this.publishProperty('smart_care_v2', smartCareV2 ? 'ON' : 'OFF')
        }
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'fridge_temp': {
                const degC = Math.round(Number(mqttValue))
                if (!Number.isFinite(degC)) return
                const clamped = Math.min(Math.max(degC, FRIDGE_TEMP_MIN), FRIDGE_TEMP_MAX)
                this.send(buildFridgeTempWrite(clamped))
                // Published optimistically for a snappy UI; the real `10 ec` state frame that
                // follows the ack corrects this if needed - see the file header.
                this.fridgeTemp = clamped
                this.publishProperty('fridge_temp', clamped)
                return
            }
            case 'freezer_temp': {
                const degC = Math.round(Number(mqttValue))
                if (!Number.isFinite(degC)) return
                const clamped = Math.min(Math.max(degC, FREEZER_TEMP_MIN), FREEZER_TEMP_MAX)
                this.send(buildFreezerTempWrite(clamped))
                this.freezerTemp = clamped
                this.publishProperty('freezer_temp', clamped)
                return
            }
            case 'express_mode': {
                const on = mqttValue === 'ON'
                this.send(buildExpressModeWrite(on))
                this.expressMode = on
                this.publishProperty('express_mode', on ? 'ON' : 'OFF')
                return
            }
            case 'smart_care_v2': {
                const on = mqttValue === 'ON'
                for (const frame of buildSmartCareV2Writes(on)) this.send(frame)
                this.smartCareV2 = on
                this.publishProperty('smart_care_v2', on ? 'ON' : 'OFF')
                return
            }
            default:
                console.warn(`2REF21EBNSX_3: attempting to set unknown property ${prop}`)
        }
    }

    processAABB(buf: Buffer) {
        // ack: <sub=0x10> 00 17 00  (4 bytes) - nothing to publish, just confirms the write landed
        if (buf.length === 4 && buf[0] === ACK_SUB && buf[1] === 0x00 && buf[2] === ACK_OPCODE && buf[3] === 0x00)
            return

        // state: <sub=0x10> ec <old 18-byte record><new 18-byte record> - see the file header.
        if (buf.length === 2 + 2 * STATE_RECORD_LEN && buf[0] === STATE_SUB && buf[1] === STATE_OPCODE) {
            this.applyStateRecord(buf.subarray(2 + STATE_RECORD_LEN, 2 + 2 * STATE_RECORD_LEN))
            return
        }

        // query response: <sub=0x10> eb <18-byte record> - see the file header.
        if (buf.length === 2 + STATE_RECORD_LEN && buf[0] === QUERY_SUB && buf[1] === QUERY_OPCODE) {
            this.applyStateRecord(buf.subarray(2, 2 + STATE_RECORD_LEN))
            return
        }

        // per-compartment door event: <sub=0x10> a8 <compartment> <state> - see the file header's
        // DOOR OPEN BY COMPARTMENT section.
        if (buf.length === 4 && buf[0] === DOOR_EVENT_SUB && buf[1] === DOOR_EVENT_OPCODE) {
            const open = buf[3] === 1
            if (buf[2] === DOOR_EVENT_COMPARTMENT_FRIDGE && open !== this.fridgeDoorOpen) {
                this.fridgeDoorOpen = open
                this.publishProperty('fridge_door_open', open ? 'ON' : 'OFF')
            } else if (buf[2] === DOOR_EVENT_COMPARTMENT_FREEZER && open !== this.freezerDoorOpen) {
                this.freezerDoorOpen = open
                this.publishProperty('freezer_door_open', open ? 'ON' : 'OFF')
            }
            return
        }

        // energy counter: <sub=0x10> af <?> 00 <hi> 04 04 - see the file header's ENERGY COUNTER
        // section. Unlike plplaaa2/rethink's own handler for a different fridge model, this does
        // not gate on byte 2's value - this unit's own captures show it ranging far more widely
        // than that other handler's `0x0f`/`0x10` check accounts for.
        if (buf.length === ENERGY_FRAME_LEN && buf[0] === ENERGY_SUB && buf[1] === ENERGY_OPCODE) {
            const counter = buf[ENERGY_COUNTER_HI] * 256 + buf[ENERGY_COUNTER_LO]
            if (counter !== this.energyRawCounter) {
                this.energyRawCounter = counter
                this.publishProperty('energy_raw_counter', counter)
            }
            return
        }

        // periodic full status dump: <sub=0x10> cf <248 bytes> - see the file header's
        // NOT YET DECODED note (food-poisoning-index, MonitoringValue table). Recognised and
        // silently dropped rather than left to keep tripping the unmodelled-frame note below on
        // every ~5-minute cycle - there's nothing new to learn from it that hasn't already been
        // looked at, just noise.
        if (buf.length === 250 && buf[0] === STATE_SUB && buf[1] === 0xcf) return

        // Anything else is a frame this handler does not parse yet (convertibleTemp among them).
        // Note it once per shape so a future session has something to grep for, the same way
        // TLVDevice.noteUnknownTags does for the AC family.
        const key = buf.length > 0 ? `${buf.length}:${buf[0].toString(16)}:${(buf[1] ?? 0).toString(16)}` : 'empty'
        if (!this.seenUnknown.has(key)) {
            this.seenUnknown.add(key)
            log('status', this.id, `2REF21EBNSX_3: unrecognised frame shape (len=${buf.length}, buf[0..1]=${key})`)
            recordNote(this.id, this.thinq.meta, 'unmodelled-aabb-frame', { len: buf.length, head: key })
        }
    }
}
