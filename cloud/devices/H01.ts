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
 *
 * POWER READ-BACK - TRIED AND RETRACTED (2026-09-12): `buf[28]` of the 0xEC dual-record status
 * frame looked like power at first - reading `0x00` right after OFF and `0x08` right after ON, both
 * directions, driving the switch myself on my.lgthinq.com. That held up for exactly those two
 * samples. A real physical on/off at the appliance the same day broke it: `buf[28]` (both the 0xEC
 * ambient version and the equivalent `buf[2]` of a query-triggered 0xEB, see QUERY_FRAME below)
 * oscillated 0/8 repeatedly across a single on-then-off (not a clean pair of readings), and then
 * settled on `0` while the appliance was confirmed still ON - i.e. flatly wrong, not just noisy
 * during a transition. Whatever this byte tracks, it is not simply power. `power` is back to being
 * published only optimistically from `setProperty`, the same as before this was tried - see
 * MI2D7B.ts/RD20_S.ts for the same caution about their own analogous, still-unconfirmed reads of
 * the same frame family. The two frame shapes are still recognised below (so they do not spam the
 * unmodelled-frame log) but nothing is read from them.
 */

const ACK_SUB = 0x32
const ACK_OPCODE = 0x26
const STATUS_TYPE = 0xec
const STATUS_MIN_LEN = 28 + 1

function buildPowerWrite(on: boolean): Buffer {
    return Buffer.from([0xf0, 0x26, on ? 0x16 : 0x12])
}

/** TRIAL (2026-09-12): see RD20_S.ts's identical constant for why this fridge-family query frame
 *  is worth trying here too - a no-op if this appliance ignores it. */
const QUERY_FRAME = Buffer.from('f0ed1211010000010400', 'hex')
const QUERY_INTERVAL_MS = 5 * 60 * 1000

export default class Device extends AABBDevice {
    power: boolean | undefined

    private queryTimer: ReturnType<typeof setInterval> | undefined

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
            },
        })

        this.setConfig(config)
        log('status', this.id, 'H01 (식기세척기) handler started - power on/off only, see file header')
    }

    start() {
        super.start()
        this.send(QUERY_FRAME)
        this.queryTimer = setInterval(() => this.send(QUERY_FRAME), QUERY_INTERVAL_MS)
    }

    cancelPendingWork() {
        clearInterval(this.queryTimer)
        this.queryTimer = undefined
        super.cancelPendingWork()
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

        // 0xEC dual-record status frame and 0xEB single-record query response - see file header's
        // POWER READ-BACK section for why nothing is read from either any more. Recognised by
        // shape and silently dropped so they do not spam the unmodelled-frame log.
        if (buf[0] === ACK_SUB && buf[1] === STATUS_TYPE && buf.length >= STATUS_MIN_LEN) return
        if (buf[0] === ACK_SUB && buf[1] === 0xeb && buf.length >= 3) return

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
