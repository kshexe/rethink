import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type DeviceDiscovery } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { note as recordNote } from '../frame-recorder'

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
 */

const FROM_DEVICE_ACK_OPCODE = 0xe5

/** Shared with FX___S.ts's vocabulary for the same F0E5 protocol family. */
const KEY_POWER = 0x02

/** Builds the `f0 e5 00 02 01 ff <n> [<key> <value>]*n` payload AABBDevice.send() wraps and
 *  checksums. Only single-byte values are needed for power; see the file header for the
 *  multi-key, partly-16-bit shape this opcode also carries on this model. */
function buildSettingsWrite(pairs: [key: number, value: number][]): Buffer {
    const body = [0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff, pairs.length]
    for (const [key, value] of pairs) body.push(key, value)
    return Buffer.from(body)
}

export default class Device extends AABBDevice {
    power: boolean | undefined

    /** (dir:tag) pairs already flagged as unrecognised, so a repeating one is noted once. */
    private seenUnknown = new Set<string>()

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        const config: DeviceDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Dryer' }),
            components: {
                power: {
                    platform: 'switch',
                    unique_id: '$deviceid-power',
                    state_topic: '$this/power',
                    command_topic: '$this/power/set',
                    name: '',
                    icon: 'mdi:tumble-dryer',
                },
            },
        })

        this.setConfig(config)
        log('status', this.id, 'RD20_S (건조기) handler started - power on/off only, see file header')
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

    processAABB(buf: Buffer) {
        // ack: <sub> 00 e5 00  (4 bytes) - nothing to publish, just confirms the write landed
        if (buf.length === 4 && buf[1] === 0x00 && buf[2] === FROM_DEVICE_ACK_OPCODE && buf[3] === 0x00) return

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
