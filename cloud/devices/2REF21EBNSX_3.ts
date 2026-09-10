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
 *   offset 3   fridge compartment setpoint, raw = degC directly (confirmed 1, 4, 7)
 *   offset 4   freezer compartment setpoint, raw = -14 - degC   (confirmed -23->9, -18->4, -15->1)
 *   offset 5   express freeze, 0x01 = off, 0x02 = on
 *   offset 10  0x01 whenever offset 3 or 4 is being written, 0xff (untouched) otherwise - copied
 *              verbatim from the real captures; what it actually means is not established
 *   offset 19  Smart Care+ (스마트케어+) master switch, 0x01 = on. Turning it off in the app sent
 *              TWO separate writes - this one at 0x00, and a second frame with offset 6 = 0x06 -
 *              while turning it back on sent only the first (offset 19 = 0x01, offset 6 untouched
 *              at 0xff). Both writes are replayed on OFF, matching the app exactly; only the
 *              first is needed for ON. What offset 6 = 0x06 specifically means is not established
 *              (Smart Care+ is a bundle over three sub-features - it may pin one of them rather
 *              than being part of the on/off state itself), so nothing here writes offset 6 on
 *              its own or reads it back.
 *
 * Read-side: every write's ack is followed by a `10 ec` frame carrying two back-to-back 18-byte
 * records - the value just replaced, then the value now in effect (confirmed against all 8 sweep
 * captures plus the Smart Care+ toggle: the "before" record of each write byte-for-byte matches
 * the "after" record of the write that preceded it). Only the second (current) record is read
 * here:
 *
 *   record[1]  fridge compartment setpoint, raw = degC directly
 *   record[2]  freezer compartment setpoint, raw = -14 - degC
 *   record[3]  express freeze, 0x01 = off, 0x02 = on
 *   record[4]  Smart Care+, 0x02 = off, 0x07 = on (confirmed both directions: this flipped
 *              0x07->0x02 in the state frame right after the offset-19/offset-6 OFF write pair,
 *              and 0x02->0x07 right after the offset-19-only ON write)
 *
 * The remaining bytes of both records (0,5-17) never changed across a full day's captures, so
 * they are read but not asserted on - see the note above 0x39 (57, the food-poisoning-index shown
 * on the Smart Care+ / 스마트 안심 보관 page) not appearing anywhere in this record: that value is
 * described in the app as computed from temperature *and* humidity, so it is likely derived
 * cloud-side rather than transmitted as a single number, and was not pursued further. This frame
 * is what actually keeps the four entities below in sync - `setProperty` also publishes
 * optimistically first, for a snappy UI, but this real reading is what corrects it if anything
 * else (the appliance's own panel, the LG app, ...) changes a setting instead.
 *
 * NOT YET DECODED, left deliberately unmodelled:
 *   - Smart Care+'s three sub-features individually (스마트 안심 보관/AI 신선 케어/에너지 절약
 *     모드) - only the master switch above is exposed.
 *   - the periodic ~5-minute full status dump (`10 cf`, 250 bytes) - looked at for the
 *     food-poisoning-index (see above) and otherwise not investigated further.
 *
 * See RETHINK memory `rethink_migration_status` for the raw capture log this was built from.
 */

const ACK_SUB = 0x10
const ACK_OPCODE = 0x17

const OFFSET_FRIDGE_TEMP = 3
const OFFSET_FREEZER_TEMP = 4
const OFFSET_EXPRESS_FREEZE = 5
const OFFSET_APPLY_FLAG = 10
const OFFSET_SMART_CARE = 19
/** Only ever sent alongside offset 19 = 0x00 when turning Smart Care+ off - see the file header. */
const OFFSET_SMART_CARE_OFF_EXTRA = 6

const STATE_SUB = 0x10
const STATE_OPCODE = 0xec
const STATE_RECORD_LEN = 18
/** Offsets within a state record (18 bytes - the current half of an `ec` pair, or the sole
 *  record an `eb` query response carries). */
const RECORD_FRIDGE_TEMP = 1
const RECORD_FREEZER_TEMP = 2
const RECORD_EXPRESS_FREEZE = 3
const RECORD_SMART_CARE = 4

const QUERY_SUB = 0x10
const QUERY_OPCODE = 0xeb
/** Fixed, parameterless - see the file header. */
const QUERY_FRAME = Buffer.from('f0ed1211010000010400', 'hex')
const QUERY_INTERVAL_MS = 5 * 60 * 1000

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

function buildExpressFreezeWrite(on: boolean): Buffer {
    const body = newWriteBody()
    body[OFFSET_EXPRESS_FREEZE] = on ? 0x02 : 0x01
    return body
}

/** ON is a single write; OFF is the two-frame sequence the app itself sends - see the file
 *  header for why the second frame (offset 6 = 0x06) is replayed verbatim rather than modelled. */
function buildSmartCareWrites(on: boolean): Buffer[] {
    const first = newWriteBody()
    first[OFFSET_SMART_CARE] = on ? 0x01 : 0x00
    if (on) return [first]

    const second = newWriteBody()
    second[OFFSET_SMART_CARE_OFF_EXTRA] = 0x06
    return [first, second]
}

export default class Device extends AABBDevice {
    fridgeTemp: number | undefined
    freezerTemp: number | undefined
    expressFreeze: boolean | undefined
    smartCare: boolean | undefined

    /** (dir:tag) pairs already flagged as unrecognised, so a repeating one is noted once. */
    private seenUnknown = new Set<string>()
    private queryTimer: ReturnType<typeof setInterval> | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Fridge' }),
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
                express_freeze: {
                    platform: 'switch',
                    unique_id: '$deviceid-express_freeze',
                    name: 'Express freeze',
                    icon: 'mdi:snowflake',
                    state_topic: '$this/express_freeze',
                    command_topic: '$this/express_freeze/set',
                },
                smart_care: {
                    platform: 'switch',
                    unique_id: '$deviceid-smart_care',
                    name: 'Smart Care+',
                    icon: 'mdi:shield-check-outline',
                    state_topic: '$this/smart_care',
                    command_topic: '$this/smart_care/set',
                },
            },
        })

        this.setConfig(config)
        log(
            'status',
            this.id,
            '2REF21EBNSX_3 (냉장고) handler started - fridge/freezer temp + express freeze only, see file header',
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

        const expressFreeze = record[RECORD_EXPRESS_FREEZE] === 0x02
        if (expressFreeze !== this.expressFreeze) {
            this.expressFreeze = expressFreeze
            this.publishProperty('express_freeze', expressFreeze ? 'ON' : 'OFF')
        }

        const smartCare = record[RECORD_SMART_CARE] === 0x07
        if (smartCare !== this.smartCare) {
            this.smartCare = smartCare
            this.publishProperty('smart_care', smartCare ? 'ON' : 'OFF')
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
            case 'express_freeze': {
                const on = mqttValue === 'ON'
                this.send(buildExpressFreezeWrite(on))
                this.expressFreeze = on
                this.publishProperty('express_freeze', on ? 'ON' : 'OFF')
                return
            }
            case 'smart_care': {
                const on = mqttValue === 'ON'
                for (const frame of buildSmartCareWrites(on)) this.send(frame)
                this.smartCare = on
                this.publishProperty('smart_care', on ? 'ON' : 'OFF')
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

        // Anything else is a frame this handler does not parse yet (the periodic full status
        // dump, Smart Care+). Note it once per shape so a future session has something to grep
        // for, the same way TLVDevice.noteUnknownTags does for the AC family.
        const key = buf.length > 0 ? `${buf.length}:${buf[0].toString(16)}:${(buf[1] ?? 0).toString(16)}` : 'empty'
        if (!this.seenUnknown.has(key)) {
            this.seenUnknown.add(key)
            log('status', this.id, `2REF21EBNSX_3: unrecognised frame shape (len=${buf.length}, buf[0..1]=${key})`)
            recordNote(this.id, this.thinq.meta, 'unmodelled-aabb-frame', { len: buf.length, head: key })
        }
    }
}
