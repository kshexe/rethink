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
 *
 * Checked 2026-09-09 whether upstream's own RV13B6BSD_D_US_WIFI.ts/RV13B6ES_D_US_WIFI.ts (other
 * dryers already in this repo) could shortcut decoding the from-device status frames piling up
 * unmodelled here (kind `unmodelled-aabb-frame` in the frame log). They don't transfer: those
 * models decode status off a fixed-offset record (buf[1]==0xEC/0xEB, a marker-led record at a
 * constant offset) - a completely different protocol family from this model's F0E5 key-value
 * scheme above, so none of their byte offsets apply here. The only thing that carried over is
 * two frame-type byte VALUES matching by coincidence, not layout: buf[1]==0x72 (heartbeat) and
 * 0xE2 (idle/keepalive snapshot) appear in both, per upstream's header comment for that model.
 *
 * REMAINING_MINUTES (decoded 2026-09-10, and corrected the same day - see below): rather than
 * running a fresh test cycle, this was decoded from a real dry cycle already sitting in rethink's
 * own frame log from the day before (retained 14 days per the add-on's `frame_log_days` option) -
 * by cross-referencing the official `lg_thinq` integration's own sensors against rethink's raw
 * frames for the same window. The from-device frame that carries it is a different, longer shape
 * than the `f0e5`-ack one above: `aa ff 30 0a 00 76 00 <2-byte session counter> 00 01 00 ec 00 64
 * <98-byte body>` (118 bytes total). `buf` here (as AABBDevice.processData hands it, i.e. with
 * the leading `aa ff` and trailing checksum/bb already stripped) is 114 bytes; the marker `00 01
 * 00 ec` sits at `buf[7..10]`, and `buf[23]` is a plain integer, minutes remaining in the cycle.
 *
 * First pass (wrong): 3 samples read against `sensor.geonjogi_current_status` (running/cooling/
 * end) alone made `buf[23]` look like a 3-value status enum (0x64=running, 0x02=cooling,
 * 0x01=end), because those samples happened to land right at the start of the run (~100 min left)
 * and near the very end (~1-2 min left). Cross-checking against `sensor.geonjogi_remaining_time`
 * (a predicted finish timestamp) instead, across the same cycle, showed `buf[23]` tracking
 * `finish_time - now` in whole minutes exactly - 99, 74, 58, 11 minutes at four more points across
 * the same run, matching every time. It is not a status code at all, just the countdown - the
 * earlier reading only *looked* like one because a countdown naturally passes through small
 * integers right when a real status enum would too. There likely is a real discrete status/phase
 * byte somewhere in the other ~90 bytes of this frame (the official integration clearly has one),
 * but the running cycle mined for this pass only contained 2 cooling samples and 1 end sample -
 * not enough to isolate it with any confidence, so it is left undecoded rather than guessed at
 * twice. This frame shape stopped appearing entirely once the official sensor read "power_off" -
 * the appliance does not send it while idle, so `remaining_minutes` is simply never published for
 * that state.
 */

const FROM_DEVICE_ACK_OPCODE = 0xe5

/** Shared with FX___S.ts's vocabulary for the same F0E5 protocol family. */
const KEY_POWER = 0x02

/** The `00 01 00 ec` marker (see file header's REMAINING_MINUTES section) that opens the 114-byte
 *  status body AABBDevice.processData hands to processAABB, and where the remaining-minutes byte
 *  lives within it. */
const STATUS_FRAME_LEN = 114
const STATUS_MARKER = Buffer.from([0x00, 0x01, 0x00, 0xec])
const STATUS_MARKER_OFFSET = 7
// The frame carries two records, old then new (the same convention 2REF21EBNSX_3.ts's `10 ec`
// state frame uses) - this is the new/current one, 50 bytes after the old record's own offset.
const REMAINING_MINUTES_OFFSET = 73

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
                remaining_minutes: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining_minutes',
                    state_topic: '$this/remaining_minutes',
                    name: 'Remaining time',
                    icon: 'mdi:timer-outline',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
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

        // 114-byte status frame carrying the `00 01 00 ec` marker - see file header's
        // REMAINING_MINUTES section. Only this one field is decoded; the rest of the body is not.
        if (
            buf.length === STATUS_FRAME_LEN &&
            buf.subarray(STATUS_MARKER_OFFSET, STATUS_MARKER_OFFSET + STATUS_MARKER.length).equals(STATUS_MARKER)
        ) {
            this.publishProperty('remaining_minutes', buf[REMAINING_MINUTES_OFFSET])
            return
        }

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
