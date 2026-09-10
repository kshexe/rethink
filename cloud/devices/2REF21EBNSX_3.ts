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
 *   to-device   aa 2f f0 17 <43 bytes, see WRITE_TEMPLATE> <ck> bb
 *   from-device aa 08 10 00 17 00 <ck> bb                                (ack)
 *
 * Byte offsets confirmed by sweeping each control through its real range and diffing the frames
 * (offsets counted from the start of the 43-byte body, i.e. byte 0 is the 0xf0 of the opcode):
 *
 *   offset 3   fridge compartment setpoint, raw = degC directly (confirmed 1, 4, 7)
 *   offset 4   freezer compartment setpoint, raw = -14 - degC   (confirmed -23->9, -18->4, -15->1)
 *   offset 5   express freeze, 0x01 = off, 0x02 = on
 *   offset 10  0x01 whenever offset 3 or 4 is being written, 0xff (untouched) otherwise - copied
 *              verbatim from the real captures; what it actually means is not established
 *
 * NOT YET DECODED, left deliberately unmodelled:
 *   - Smart Care+ (스마트케어+) and its three sub-features (스마트 안심 보관/AI 신선 케어/에너지
 *     절약 모드): toggling the master switch off produced TWO writes in the one capture taken
 *     (offset 19 -> 0x00, and a separate frame with offset 6 -> 0x06), while turning it back on
 *     produced only ONE (offset 19 -> 0x01). That asymmetry means offset 6's role isn't
 *     established - it might not even be part of Smart Care+ - so nothing here acts on it.
 *   - all read-side (from-device) status frames: this handler does not know how to parse the
 *     unit's actual current setpoints/state off the wire, so every number/switch entity below is
 *     optimistic (published from the command just sent, never corrected from a real reading) -
 *     the same tradeoff MI2D7B/RD20_S/H01 make for `power`, just extended to setpoints here
 *     because nothing about the read side is understood yet.
 *
 * See RETHINK memory `rethink_migration_status` for the raw capture log this was built from.
 */

const ACK_SUB = 0x10
const ACK_OPCODE = 0x17

const OFFSET_FRIDGE_TEMP = 3
const OFFSET_FREEZER_TEMP = 4
const OFFSET_EXPRESS_FREEZE = 5
const OFFSET_APPLY_FLAG = 10

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

export default class Device extends AABBDevice {
    fridgeTemp: number | undefined
    freezerTemp: number | undefined
    expressFreeze: boolean | undefined

    /** (dir:tag) pairs already flagged as unrecognised, so a repeating one is noted once. */
    private seenUnknown = new Set<string>()

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
            },
        })

        this.setConfig(config)
        log(
            'status',
            this.id,
            '2REF21EBNSX_3 (냉장고) handler started - fridge/freezer temp + express freeze only, see file header',
        )
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'fridge_temp': {
                const degC = Math.round(Number(mqttValue))
                if (!Number.isFinite(degC)) return
                const clamped = Math.min(Math.max(degC, FRIDGE_TEMP_MIN), FRIDGE_TEMP_MAX)
                this.send(buildFridgeTempWrite(clamped))
                // Optimistic: see the file header for why this is not read back off the wire.
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
            default:
                console.warn(`2REF21EBNSX_3: attempting to set unknown property ${prop}`)
        }
    }

    processAABB(buf: Buffer) {
        // ack: <sub=0x10> 00 17 00  (4 bytes) - nothing to publish, just confirms the write landed
        if (buf.length === 4 && buf[0] === ACK_SUB && buf[1] === 0x00 && buf[2] === ACK_OPCODE && buf[3] === 0x00)
            return

        // Anything else is a frame this handler does not parse yet (status reports). Note it once
        // per shape so a future session has something to grep for, the same way
        // TLVDevice.noteUnknownTags does for the AC family.
        const key = buf.length > 0 ? `${buf.length}:${buf[0].toString(16)}:${(buf[1] ?? 0).toString(16)}` : 'empty'
        if (!this.seenUnknown.has(key)) {
            this.seenUnknown.add(key)
            log('status', this.id, `2REF21EBNSX_3: unrecognised frame shape (len=${buf.length}, buf[0..1]=${key})`)
            recordNote(this.id, this.thinq.meta, 'unmodelled-aabb-frame', { len: buf.length, head: key })
        }
    }
}
