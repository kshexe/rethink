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
 * NOTIFICATION (decoded 2026-09-14): cross-referenced the official `lg_thinq` integration's live
 * `event.miniweosi_notification` history (`event_types: [washing_is_complete,
 * error_during_washing]`) against this device's own frame log, same technique used for
 * ST_R_ETH01Y_.ts (styler) and RD20_S.ts (dryer) - RD20_S's own two-frame burst shows up here too,
 * byte-identical in structure (just this model's own sub byte, 0x20):
 *
 *   20 72 00 00 00        (buf[3]=0)
 *   20 72 00 c8 00        (buf[3]=0xc8)
 *
 * Both frames fire back to back, ~1.3-1.4s before the cloud event, confirmed on 2 independent real
 * samples (2026-09-13, 02:47 and 09:06). Only `washing_is_complete` has ever actually fired -
 * `error_during_washing` never has, so it is not known which (if either) of the two codes above
 * would carry it instead; both known codes are mapped to `washing_is_complete` here since that is
 * the only outcome either has ever been observed producing.
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
 * ENERGY (decoded 2026-09-18): mining the full frame log (10 days) for unmodelled shapes turned
 * up `7:20:3e` twice - length 7, sub 0x20, opcode 0x3e, exactly FX___S.ts's own `MSG_ENERGY`
 * opcode and `ENERGY_LEN`, whose own header comment literally shows the frame as starting `20
 * 3E`. Same family, same energy-report frame, byte for byte:
 *
 *   20 3E | <u16 Wh since the last report> | <u16 Wh cumulative> | <report number, from 1>
 *
 * Both real captures (2026-09-13T01:13:38Z: delta=156, total=156, report=1; 2026-09-13T08:35:43Z:
 * delta=21, total=21, report=1) are internally consistent with FX___S.ts's own decode - report 1
 * always has delta === total, since the running total resets to 0 at cycle start. Only two
 * samples in 10 days (this appliance sees little use, or its cycles are short enough that most
 * only ever produce report 1 before finishing) - not the multi-sample confirmation FX___S.ts's own
 * decode got, but the opcode/length/field-layout match is exact, not a guess. Unlike FX___S.ts,
 * this handler has no faster-updating state-record source for the running total, so `energy` (this
 * cycle) is published straight from this report's own `total` field - meaning it only moves about
 * once every ~15 minutes, not every state update. `<delta>` feeds `energy-accumulator.ts` for
 * hour/day/month the same way RD20_S.ts/2REF21EBNSX_3.ts/3REK2G03VI200S_2.ts/FX___S.ts do. No
 * per-report breakdown entity (FX___S.ts's `energy_reports`) - not worth the entity for two
 * samples, and this cycle's own total already says what matters.
 *
 * NOT YET DECODED: course selection (헹굼/탈수/물온도) and start. Unlike the dryer and styler,
 * this appliance's LG-app page has no "전송" (send-to-appliance) button at all - picking a
 * different course or option in the app only ever produces a client-side preview while 원격제어
 * (remote control) is armed off, with zero frames reaching the appliance (confirmed: the app
 * shows an explicit "원격제어가 꺼져 있어 코스를 바꿔도 세탁기에 업데이트되지 않습니다." warning
 * and the on-box frame log for the relevant window is empty). Capturing those needs 원격제어
 * armed at the appliance itself first.
 *
 * REMAINING_MINUTES (candidate, 2026-09-13): the TRIAL query above also carries the same
 * MSG_TUNNEL envelope FX___S.ts documents (extended-length check, inner type `0xec`/`0xeb` at
 * `payload[6]`, two 48-byte records back to back for `0xec`, one alone for `0xeb`). `record[13]`
 * tracked a real running cycle's remaining time closely across three samples ~7-9 minutes apart
 * (91 -> 84 -> 79 minutes, each drop matching the elapsed wall-clock gap to within a minute), and
 * the last of those landed within 1 of the appliance's own on-screen "OO:OO 남음" readout at the
 * same moment. Not as rigorously pinned down as RD20_S's own remaining_minutes (only 3 samples
 * from one real cycle, not a cycle mined start-to-finish down to 0, and no cross-check yet against
 * the official `lg_thinq` integration's own sensor) - published as a best-effort reading rather
 * than left undecoded, but treat a value from this field with a bit more caution than the rest of
 * this file until a full cycle confirms it reaches 0 at completion.
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

/** ACTIVE QUERY (2026-09-12, see RD20_S.ts's identical constant): this fridge-family query frame
 *  also elicits a real response here, even though nothing is read from it any more (see the
 *  processAABB comment below). Sent once on connect only, not on a repeating timer: this
 *  appliance already broadcasts its own course-table frame every 1-2s on its own, unprompted -
 *  confirmed 2026-09-13 by watching the live frame log with no query in flight at all. Re-asking
 *  every 5 minutes bought nothing beyond that one initial connect-time answer (the retracted power
 *  byte was never republished anyway), so a periodic re-query was dropped as dead weight; the
 *  appliance's own continuous chatter is what would carry a future decoded field instead. */
const QUERY_FRAME = Buffer.from('f0ed1211010000010400', 'hex')

/** See the file header's REMAINING_MINUTES section - the MSG_TUNNEL envelope FX___S.ts
 *  documents, reused here just for the record split (nothing else in the record is parsed yet). */
const MSG_TUNNEL = 0x0a
const INNER_STATE = 0xec
const INNER_STATE_SINGLE = 0xeb
const RECORD_LEN = 48
const REMAINING_MINUTES_OFFSET = 13

/** See the file header's NOTIFICATION section. Same convention as ST_R_ETH01Y_.ts/RD20_S.ts's
 *  <sub> 72 <payload> channel, sub=0x20 for this model; not a fixed frame length. */
const NOTIFY_SUB = 0x20
const NOTIFY_OPCODE = 0x72
const NOTIFY_CODE_OFFSET = 3
const NOTIFICATION: Record<number, string> = {
    0: 'washing_is_complete',
    0xc8: 'washing_is_complete',
}
const NOTIFICATION_OPTIONS = [...new Set(Object.values(NOTIFICATION))]

/** See the file header's ENERGY section. */
const ENERGY_SUB = 0x20
const ENERGY_OPCODE = 0x3e
const ENERGY_LEN = 7

export default class Device extends AABBDevice {
    power: boolean | undefined

    /** (dir:tag) pairs already flagged as unrecognised, so a repeating one is noted once. */
    private seenUnknown = new Set<string>()
    private energy: energyAccumulator.EnergyTracker | undefined

    /** The currently-published `end_time` prediction (ms since epoch), or undefined if nothing
     *  has been published yet this cycle - see FX___S.ts's identical field for the full reasoning
     *  behind the hysteresis this guards. Latched (not just cleared) on the `washing_is_complete`
     *  notification - see processAABB's NOTIFICATION branch. */
    private endTimePredicted: number | undefined

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
                // See the file header's REMAINING_MINUTES section - a candidate reading, not as
                // rigorously confirmed as this fork's other remaining_minutes fields yet.
                remaining_minutes: {
                    platform: 'sensor',
                    unique_id: '$deviceid-remaining_minutes',
                    state_topic: '$this/remaining_minutes',
                    name: 'Remaining time',
                    icon: 'mdi:timer-outline',
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                },
                // Derived from remaining_minutes - see processAABB below and FX___S.ts's identical
                // "Finish time" field, which this was modelled on directly. Latched off the
                // `washing_is_complete` notification rather than remaining_minutes reaching 0 -
                // see the file header's REMAINING_MINUTES section for why this field alone is not
                // confirmed to reach 0 at completion.
                end_time: {
                    platform: 'sensor',
                    unique_id: '$deviceid-end-time',
                    state_topic: '$this/end_time',
                    name: 'Finish time',
                    device_class: 'timestamp',
                },
                // See the file header's ENERGY section - published straight from the ~15-minute
                // report's own running total, not a faster-updating source like FX___S.ts has.
                energy: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy',
                    name: 'Energy this cycle',
                    icon: 'mdi:lightning-bolt',
                    device_class: 'energy',
                    unit_of_measurement: 'Wh',
                    state_class: 'total_increasing',
                    state_topic: '$this/energy',
                },
                energy_hour: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_hour',
                    name: 'Energy this hour',
                    icon: 'mdi:lightning-bolt',
                    device_class: 'energy',
                    unit_of_measurement: 'Wh',
                    state_class: 'total_increasing',
                    state_topic: '$this/energy_hour',
                },
                energy_day: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_day',
                    name: 'Energy today',
                    icon: 'mdi:lightning-bolt',
                    device_class: 'energy',
                    unit_of_measurement: 'Wh',
                    state_class: 'total_increasing',
                    state_topic: '$this/energy_day',
                },
                energy_month: {
                    platform: 'sensor',
                    unique_id: '$deviceid-energy_month',
                    name: 'Energy this month',
                    icon: 'mdi:lightning-bolt',
                    device_class: 'energy',
                    unit_of_measurement: 'Wh',
                    state_class: 'total_increasing',
                    state_topic: '$this/energy_month',
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
            },
        })

        this.setConfig(config)
        log(
            'status',
            this.id,
            'MI2D7B (미니워시) handler started - power on/off, remaining_minutes, energy, notification, see file header',
        )
        // Wired here, not in start(), so a delta reaching processAABB works from construction
        // onward regardless of whether/when start() runs - see the identical comment in
        // RD20_S.ts/2REF21EBNSX_3.ts/3REK2G03VI200S_2.ts/FX___S.ts.
        this.energy = energyAccumulator.attach(this.id, (property, value) => this.publishProperty(property, value))
    }

    start() {
        super.start()
        this.send(QUERY_FRAME)
    }

    cancelPendingWork() {
        this.energy?.cancel()
        this.energy = undefined
        super.cancelPendingWork()
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

    /** Events do not go through publishProperty - not deduped (a repeat of the same event must
     *  still fire) and not retained (an event entity should not replay a stale past occurrence at
     *  every reconnect) - see FX___S.ts's identical method for the full reasoning. */
    publishEvent(topic: string, eventType: string) {
        this.HA.publishProperty(this.id, topic, JSON.stringify({ event_type: eventType }), { retain: false })
    }

    processAABB(buf: Buffer) {
        // ack: <sub> 00 e5 00  (4 bytes) - nothing to publish, just confirms the write landed
        if (buf.length === 4 && buf[1] === 0x00 && buf[2] === FROM_DEVICE_ACK_OPCODE && buf[3] === 0x00) return

        // notification channel: <sub=0x20> 72 <payload> - see the file header's NOTIFICATION
        // section. Frame length is not fixed, so only the sub/opcode/gate byte are checked.
        if (buf[0] === NOTIFY_SUB && buf[1] === NOTIFY_OPCODE && buf.length > NOTIFY_CODE_OFFSET && buf[2] === 0) {
            const name = NOTIFICATION[buf[NOTIFY_CODE_OFFSET]]
            if (name !== undefined) this.publishEvent('notification', name)
            // Latch end_time at the moment washing actually completes - see the file header's
            // REMAINING_MINUTES section for why this notification is used instead of waiting for
            // remaining_minutes itself to reach 0 (not confirmed to always get there). Only when a
            // prediction was actually pending, so a stray/unexpected notification with nothing
            // running does not publish a fabricated "just finished" timestamp.
            if (name === 'washing_is_complete' && this.endTimePredicted !== undefined) {
                this.endTimePredicted = undefined
                this.publishProperty('end_time', new Date().toISOString())
            }
            return
        }

        // energy report: <sub=0x20> 3e <u16 delta><u16 total><report#> - see the file header's
        // ENERGY section.
        if (buf.length === ENERGY_LEN && buf[0] === ENERGY_SUB && buf[1] === ENERGY_OPCODE) {
            const delta = buf.readUInt16BE(2)
            const total = buf.readUInt16BE(4)
            this.publishProperty('energy', total)
            if (delta > 0) void this.energy?.recordDelta(delta)
            return
        }

        // The 57-byte `e6` echo of a power command - see file header's POWER READ-BACK section.
        if (buf.length === POWER_ECHO_LEN && buf[1] === POWER_ECHO_TYPE) {
            const on = buf[POWER_OFFSET] !== 0
            if (on !== this.power) {
                this.power = on
                this.publishProperty('power', on ? 'ON' : 'OFF')
            }
            return
        }

        // Response to the TRIAL query (see the QUERY_FRAME note above) - the power bit here was
        // TRIED AND RETRACTED (2026-09-12, same as H01.ts's identical analogy: the equivalent
        // byte there turned out not to track power at all), but see the file header's
        // REMAINING_MINUTES section for the one field that is now read from it.
        if (buf[1] === MSG_TUNNEL) {
            const extended = buf.readUInt16BE(2) === buf.length + 4
            const payload = extended ? buf.subarray(4) : buf.subarray(2)
            if (payload.length > 6) {
                const data = payload.subarray(10)
                const offset = payload[6] === INNER_STATE ? RECORD_LEN : payload[6] === INNER_STATE_SINGLE ? 0 : -1
                if (offset >= 0 && data.length >= offset + RECORD_LEN) {
                    const record = data.subarray(offset, offset + RECORD_LEN)
                    const remaining = record[REMAINING_MINUTES_OFFSET]
                    this.publishProperty('remaining_minutes', remaining)

                    // end_time prediction while a cycle is genuinely in progress - see FX___S.ts's
                    // identical derivation. Completion itself is latched off the notification
                    // above rather than `remaining` reaching 0 - see the file header's
                    // REMAINING_MINUTES section - so this branch only ever needs to handle the
                    // "still counting down" case, never a reset.
                    if (remaining > 0) {
                        const predicted = Date.now() + remaining * 60_000
                        if (
                            this.endTimePredicted === undefined ||
                            Math.abs(predicted - this.endTimePredicted) >= 60_000
                        ) {
                            this.endTimePredicted = predicted
                            this.publishProperty(
                                'end_time',
                                new Date(Math.round(predicted / 60_000) * 60_000).toISOString(),
                            )
                        }
                    }
                    return
                }
            }
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
