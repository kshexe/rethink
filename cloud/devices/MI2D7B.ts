import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection, type DeviceDiscovery } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import HADevice from './base'
import AABBDevice from './aabb_device'
import log from '@/util/logging'
import { note as recordNote } from '../frame-recorder'

/*
 * LG MiniWash (미니워시), ThinQ model MI2D7B, deviceType 201.
 *
 * Shares the AA..BB envelope and the F0 E5 settings-write opcode that FX___S.ts (a front-load
 * washer) already documents in detail: `f0 e5 00 02 01 ff <n> [<key> <value...>]*n`, where <n> is
 * the number of key/value pairs that follow. KEY_POWER (0x02) is one of those keys and this
 * appliance answers to the exact same encoding - captured directly against a real unit on
 * 2026-09-09 by clicking the power switch on my.lgthinq.com and reading the resulting frame back
 * off rethink's on-box capture log (`/share/rethink/frames/<date>.jsonl`), matched to the click by
 * timestamp:
 *
 *   to-device   aa 0d f0 e5 00 02 01 ff 01 02 <00=off|01=on> <ck> bb
 *   from-device aa 08 20 00 e5 00 <ck> bb                                (ack)
 *
 * Power on and off were both captured this way, byte for byte identical to RD20_S (dryer) and
 * ST_R_ETH01Y_ (styler) except the from-device leading byte (0x20 here, a device-class marker -
 * not asserted against below since nothing here depends on it).
 *
 * The ack is followed by a much longer from-device frame (61 bytes) that STARTS with what looks
 * like the same shape ST_R_ETH01Y_'s clean 13-byte power echo has - `e6 00 02 01 ff 01 02` - and
 * was briefly read as one. It is not: that styler echo's next byte is the state that was just
 * set (0x01 for the ON capture that produced it), but this appliance's 61-byte frame has 0x00
 * there in BOTH the power-on and power-off captures, so that position is not carrying power
 * state here - it is more likely this model's periodic/idle status report, which happens to
 * share a fixed constant preamble with the power-echo shape rather than being one. So this
 * handler does not attempt to read power state back off the wire; `power` is published
 * optimistically from the command this handler itself just sent (see setProperty).
 *
 * POWER READ-BACK (decoded 2026-09-12): the position checked above (right after the `00 02 01 ff
 * 01 02` prefix) really is always 0x00, but that is not the only candidate in the 61-byte frame.
 * Driving the power switch myself on my.lgthinq.com and diffing the immediate command->echo round
 * trip (no timing ambiguity - the echo lands in the same second as the command) shows `buf[46]`
 * (buf being this 57-byte frame as processAABB receives it, i.e. with the leading `aa 3d` and
 * trailing checksum/bb already stripped) is `0x00` right after OFF and `0x02` right after ON,
 * confirmed both directions. `power` is now read from this byte when the frame arrives, in
 * addition to the existing optimistic publish from `setProperty`.
 *
 * NOT YET DECODED: course selection (헹굼/탈수/물온도) and start. Unlike the dryer and styler,
 * this appliance's LG-app page has no "전송" (send-to-appliance) button at all - picking a
 * different course or option in the app only ever produces a client-side preview while 원격제어
 * (remote control) is armed off, with zero frames reaching the appliance (confirmed: the app
 * shows an explicit "원격제어가 꺼져 있어 코스를 바꿔도 세탁기에 업데이트되지 않습니다." warning
 * and the on-box frame log for the relevant window is empty). Capturing those needs 원격제어
 * armed at the appliance itself first.
 */

const FROM_DEVICE_ACK_OPCODE = 0xe5

/** See the file header's POWER READ-BACK section. */
const POWER_ECHO_TYPE = 0xe6
const POWER_ECHO_LEN = 57
const POWER_OFFSET = 46

/** Shared with FX___S.ts's vocabulary for the same F0E5 protocol family. */
const KEY_POWER = 0x02

/** Builds the `f0 e5 00 02 01 ff <n> [<key> <value>]*n` payload AABBDevice.send() wraps and
 *  checksums. Every value here has been single-byte so far; this device has no 16-bit key
 *  (like FX___S's KEY_RESERVE) confirmed yet, so only single-byte values are supported. */
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
            ...HADevice.config(meta),
            components: {
                power: {
                    platform: 'switch',
                    unique_id: '$deviceid-power',
                    state_topic: '$this/power',
                    command_topic: '$this/power/set',
                    name: '',
                    icon: 'mdi:washing-machine',
                },
            },
        })

        this.setConfig(config)
        log('status', this.id, 'MI2D7B (미니워시) handler started - power on/off only, see file header')
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
                console.warn(`MI2D7B: attempting to set unknown property ${prop}`)
        }
    }

    processAABB(buf: Buffer) {
        // ack: <sub> 00 e5 00  (4 bytes) - nothing to publish, just confirms the write landed
        if (buf.length === 4 && buf[1] === 0x00 && buf[2] === FROM_DEVICE_ACK_OPCODE && buf[3] === 0x00) return

        // The 57-byte `e6` echo of a power command - see file header's POWER READ-BACK section.
        if (buf.length === POWER_ECHO_LEN && buf[1] === POWER_ECHO_TYPE) {
            const on = buf[POWER_OFFSET] !== 0
            if (on !== this.power) {
                this.power = on
                this.publishProperty('power', on ? 'ON' : 'OFF')
            }
            return
        }

        // Anything else is a frame this handler does not parse yet (the 61-byte periodic status
        // report, course table, options). Note it once per shape so a future session has
        // something to grep for, the same way TLVDevice.noteUnknownTags does for the AC family.
        const key = buf.length > 0 ? `${buf.length}:${buf[0].toString(16)}:${(buf[1] ?? 0).toString(16)}` : 'empty'
        if (!this.seenUnknown.has(key)) {
            this.seenUnknown.add(key)
            log('status', this.id, `MI2D7B: unrecognised frame shape (len=${buf.length}, buf[0..1]=${key})`)
            recordNote(this.id, this.thinq.meta, 'unmodelled-aabb-frame', { len: buf.length, head: key })
        }
    }
}
