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
 * `power` is published optimistically (not read back off the wire) for the same reason as
 * MI2D7B/RD20_S: the ack is a fixed 4-byte shape with no state in it, and the longer from-device
 * frames that follow (a 0xEC dual-record status, and a very long 0x0A frame that turned out to be
 * this model's course-name table - "DW-1-1".."DW-5-1" etc, ASCII, the same kind of static table
 * ST_R_ETH01Y_'s len=86/87 shape turned out to be) are not decoded yet.
 *
 * NOT YET DECODED: course selection/start, and the options seen in the app's course-detail screen
 * (조용히 세척/스팀/집중세척/고온살균/안심헹굼/열풍건조). Left for a future session with more
 * captures - see RETHINK memory `rethink_migration_status` for the raw findings this was built
 * from.
 */

const ACK_SUB = 0x32
const ACK_OPCODE = 0x26

function buildPowerWrite(on: boolean): Buffer {
    return Buffer.from([0xf0, 0x26, on ? 0x16 : 0x12])
}

export default class Device extends AABBDevice {
    power: boolean | undefined

    /** (dir:tag) pairs already flagged as unrecognised, so a repeating one is noted once. */
    private seenUnknown = new Set<string>()

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Dishwasher' }),
            components: {
                power: {
                    platform: 'switch',
                    unique_id: '$deviceid-power',
                    state_topic: '$this/power',
                    command_topic: '$this/power/set',
                    name: '',
                    icon: 'mdi:dishwasher',
                },
            },
        })

        this.setConfig(config)
        log('status', this.id, 'H01 (식기세척기) handler started - power on/off only, see file header')
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

    processAABB(buf: Buffer) {
        // ack: <sub=0x32> 00 26 00  (4 bytes) - nothing to publish, just confirms the write landed
        if (buf.length === 4 && buf[0] === ACK_SUB && buf[1] === 0x00 && buf[2] === ACK_OPCODE && buf[3] === 0x00)
            return

        // Anything else is a frame this handler does not parse yet (status reports, the course
        // table). Note it once per shape so a future session has something to grep for, the same
        // way TLVDevice.noteUnknownTags does for the AC family.
        const key = buf.length > 0 ? `${buf.length}:${buf[0].toString(16)}:${(buf[1] ?? 0).toString(16)}` : 'empty'
        if (!this.seenUnknown.has(key)) {
            this.seenUnknown.add(key)
            log('status', this.id, `H01: unrecognised frame shape (len=${buf.length}, buf[0..1]=${key})`)
            recordNote(this.id, this.thinq.meta, 'unmodelled-aabb-frame', { len: buf.length, head: key })
        }
    }
}
