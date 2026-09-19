// base implementation for devices with a TLV-based payload format
import HADevice from './base'

import crc16 from '@/util/crc16'
import * as TLV from '@/util/tlv'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import log from '@/util/logging'
import { note as recordNote } from '../frame-recorder'

/** TLV tags that carry protocol structure, not a device field - never "unknown". 0x1f5 is the
 *  caps/values query marker; the rest are the capability bitmaps ACDevice consumes directly. */
const STRUCTURAL_TAGS = new Set([0x1f5, 0x2c1, 0x2c2, 0x2cc, 0x2cd, 0x2d3, 0x2da, 0x2e1, 0x2e2])

export type FieldDefinition = {
    id?: number
    name: string
    comp: string
    state_topic?: string
    readable?: boolean
    writable?: boolean
    write_xform?: (val: string) => string | number | null | undefined
    write_attach?: number[] | ((val: unknown) => number[])
    read_xform?: (val: number) => string | number | undefined // undefined return values are discarded
    read_callback?: (val: string | number) => boolean
    write_callback?: (val: number) => boolean
}

export default class TLVDevice extends HADevice {
    query_timer: ReturnType<typeof setInterval> | undefined
    query_last_timestamp: number | undefined = undefined
    query_last_interval: number | undefined = undefined
    fields_by_id: Record<number, FieldDefinition> = {}
    fields_by_ha: Record<string, FieldDefinition> = {}
    raw_clip_state: Record<number, number> = {}
    query_caps_timeout: ReturnType<typeof setInterval> | undefined = undefined
    query_values_timeout: ReturnType<typeof setInterval> | undefined = undefined

    /** (dir:tag) pairs already flagged as unknown, so a repeating one is noted once per session. */
    private _seenUnknownTags = new Set<string>()

    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
    ) {
        super(HA, thinq.id)
        thinq.on('data', (data) => this.processData(data))
        // Every frame pushed to the appliance, whether this handler built it or the LG-cloud
        // bridge forwarded it. Ours only carry tags we know; a bridged one that carries a tag
        // with no FieldDefinition is a command this handler cannot parse - note it.
        thinq.on('sendData', (buf) => this.inspectOutboundTLV(buf))

        // initial capabilities query
        this.queryCaps()

        // retry every 15 s until caps are received
        this.query_caps_timeout = setInterval(() => {
            log('status', this.id, 're-trying capabilities query due to timeout')
            this.queryCaps()
        }, 15 * 1000)
    }

    // we waste memory by storing the field set per-device, not per-class. Whatever.
    addField(config: DeviceDiscovery, options: FieldDefinition, autoreg?: boolean) {
        if (options.id) this.fields_by_id[options.id] = options

        let fullName = options.comp + '-' + options.name
        this.fields_by_ha[fullName] = options

        if (autoreg !== false) {
            let topicPrefix: string = ''
            if (options.name !== '') {
                topicPrefix = options.name + '_'
            }

            let target = config['components'][options.comp] as any

            if (options.readable !== false) {
                const stateTopic = options.state_topic == null ? 'state_topic' : options.state_topic
                target[topicPrefix + stateTopic] = '$this/' + fullName
            }

            if (options.writable !== false) target[topicPrefix + 'command_topic'] = '$this/' + fullName + '/set'
        }
    }

    // clip-side
    queryCaps() {
        this.send([1, 1, 2, 2, 1], [{ t: 0x1f5, v: 1 }])
    }

    query() {
        this.send([1, 1, 2, 2, 1], [{ t: 0x1f5, v: 2 }])
        this.query_last_timestamp = performance.now()
    }

    setQueryInterval(interval: number = 15 * 60 * 1000) {
        if (this.query_timer != undefined) {
            if (this.query_last_interval === interval) return

            if (this.query_last_timestamp != null && performance.now() - this.query_last_timestamp >= interval) {
                log('status', this.id, 'sending immediate refresh query due to changed interval to', interval / 1000)
                this.query()
            } else {
                log('status', this.id, 'changing refresh query interval to', interval / 1000)
            }

            clearInterval(this.query_timer)
        }
        this.query_timer = setInterval(() => {
            log('status', this.id, 'sending periodic refresh query')
            this.query()
        }, interval)
        this.query_last_interval = interval
    }

    start() {
        /*
         * Set initial query interval timer if something hasn't already set it.
         * Refresh every 15 minutes by default since not every tag change
         * generates async notify.
         */
        if (this.query_timer == null) this.setQueryInterval()
    }

    drop() {
        if (this.query_timer != undefined) {
            clearInterval(this.query_timer)
            this.query_timer = undefined
        }

        if (this.query_caps_timeout != undefined) {
            clearInterval(this.query_caps_timeout)
            this.query_caps_timeout = undefined
        }

        if (this.query_values_timeout != undefined) {
            clearInterval(this.query_values_timeout)
            this.query_values_timeout = undefined
        }

        if (this.pendingBridgeRefresh != undefined) {
            clearTimeout(this.pendingBridgeRefresh)
            this.pendingBridgeRefresh = undefined
        }

        super.drop()
    }

    processData(buf: Buffer) {
        if (
            buf[2] == 0x04 &&
            buf[3] == 0x00 &&
            buf[4] == 0x00 &&
            buf[5] == 0x00 &&
            (buf[6] == 0x87 || buf[6] == 0xa7) &&
            buf[7] == 0x02 &&
            (buf[8] == 0x01 || buf[8] == 0x04) &&
            /* && buf[9] is a "sequence" number */ buf[10] == buf.length - 13
        ) {
            // ignore the CRC, we assume that the modem verifies it :/
            // 0x87 used by RAC/WIN; 0xA7 used by DHUM_056905_WW and similar
            log('status', this.id, 'received TLV packet')
            this.processTLV(TLV.parse(buf.subarray(11, buf.length - 2)))
        }
        if (
            buf[1] == 0xff &&
            buf[2] == 0x04 &&
            buf[3] == 0x00 &&
            buf[4] == 0x00 &&
            buf[5] == 0x00 &&
            buf[6] == 0x87 &&
            buf[7] == 0xfd &&
            buf[8] == 0x03 &&
            buf[10] == buf.length - 13
        ) {
            this.processPrivData(buf[0], buf[9], buf.subarray(11, buf.length - 2))
        }
        if (
            (buf[0] == 0x02 || buf[0] == 0x03) &&
            buf[2] == 0x04 &&
            buf[3] == 0x00 &&
            buf[4] == 0x00 &&
            buf[5] == 0x00 &&
            buf[6] == 0x87 &&
            buf[7] == 0xfd &&
            buf[8] == 0x10 &&
            buf[9] == 0x00 &&
            buf[10] == 0x05 &&
            buf[11] == 0xfe &&
            buf[12] != null
        ) {
            this.processPrivDataCmdResp(buf[0] == 0x02, buf[1], buf[12], buf.subarray(13, buf.length - 2))
        }
    }

    send(header: number[], tlv: TLV.TLV[]) {
        const [b0, b1, b2, b3, b4] = header
        const tlvArray = TLV.build(tlv)
        let buf = [0x04, 0x00, 0x00, 0x00, 0x65, b2, b3, b4, tlvArray.length].concat(tlvArray)
        const result = crc16(buf)
        buf = [b0, b1].concat(buf, [result >> 8, result & 0xff])
        this.thinq.send_packet(Buffer.from(buf))
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        /* To be overridden */
        return false
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        /* To be overridden */
        return false
    }

    sendPrivCommand(cmd: number, cmd_sub: number, data: Buffer = Buffer.alloc(0)) {
        const cmdDataLen = data.length + 1
        const header = Buffer.from([
            0x00,
            0xff,
            0x04,
            0x00,
            0x00,
            0x00,
            0x65,
            0xfd,
            cmd_sub,
            cmdDataLen >> 8,
            cmdDataLen & 0xff,
            cmd,
        ])
        let buf = Buffer.concat([header, data])

        const crc = crc16(buf.subarray(2))
        buf = Buffer.concat([buf, Buffer.from([crc >> 8, crc & 0xff])])

        this.thinq.send_packet(buf)
    }

    capabilityReceived() {
        /* To be overridden if necessary */
    }

    valuesReceived() {
        /* To be overridden if necessary */
    }

    processPrivData(cmd: number, buf9: number, data: Buffer) {
        /* To be overridden */
    }

    processPrivDataCmdResp(success: boolean, buf1: number, cmd: number, data: Buffer) {
        /* To be overridden */
    }

    /** Every TLV tag this handler does something with. The base set is the fields registered
     *  through addField plus the structural tags; a subclass that consumes tags directly from
     *  raw_clip_state (ACDevice does) must add them here or they read as unmodelled. */
    knownTagIds(): Set<number> {
        const s = new Set<number>(STRUCTURAL_TAGS)
        for (const id of Object.keys(this.fields_by_id)) s.add(Number(id))
        return s
    }

    /** Note any TLV tag this handler does not model - a value the appliance reports, or a command
     *  the cloud sends, that never reaches an entity. Deduped per direction+tag; belated (written
     *  when parsed, not when the frame arrived) is fine. */
    noteUnknownTags(dir: 'from-device' | 'to-device', tlvArray: TLV.TLV[]) {
        const known = this.knownTagIds()
        for (const { t, v } of tlvArray) {
            if (known.has(t)) continue
            const key = `${dir}:${t}`
            if (this._seenUnknownTags.has(key)) continue
            this._seenUnknownTags.add(key)
            const tag = '0x' + t.toString(16)
            log('status', this.id, `unmodelled TLV tag ${tag} (${dir}) = ${v}`)
            recordNote(this.id, this.thinq.meta, 'unmodelled-tlv-tag', { dir, tag, value: v })
        }
    }

    /** How long to wait after a bridge-relayed command before pulling a confirmatory read - see
     *  inspectOutboundTLV. Grounded in the three write-to-reflected-read gaps measured live
     *  2026-09-18 (0.573s/0.618s/0.854s, all under a second), with roughly 150-400ms of margin
     *  over the slowest of those rather than a round-number guess. */
    private static readonly BRIDGE_REFRESH_DELAY_MS = 1000

    /** A confirmatory query scheduled by inspectOutboundTLV - see BRIDGE_REFRESH_DELAY_MS. A true
     *  debounce: each new outbound command carrying a known field RESETS this timer rather than
     *  leaving an already-pending one alone, so the query only fires BRIDGE_REFRESH_DELAY_MS after
     *  the LAST command in a burst, not the first. That matters when a burst is made of more than
     *  one distinct command close together (mode then temperature, say) - firing after the first
     *  one risks reading the appliance mid-way through applying the rest, with no further query
     *  scheduled to catch the final state. Queries spaced further apart than the delay still each
     *  get their own timer and fire independently, same as before - only writes landing within the
     *  window of the one immediately before them get folded into a single later query. */
    private pendingBridgeRefresh: ReturnType<typeof setTimeout> | undefined

    /** A values-write frame going out to the appliance: `b0 b1 04 00 00 00 65 02 <b3> <b4>
     *  <tlvLen> <tlv> <crc16>`. buf[7]==0x02 is the values channel - buf[7]==0xFD is the
     *  priv-data command channel, whose body is not a TLV list and must not be parsed as one. */
    inspectOutboundTLV(buf: Buffer) {
        if (!Buffer.isBuffer(buf) || buf.length < 14) return
        if (buf[2] !== 0x04 || buf[6] !== 0x65 || buf[7] !== 0x02) return
        if (buf[10] !== buf.length - 13) return
        const tlv = TLV.parse(buf.subarray(11, buf.length - 2))
        // The caps/values poll this class sends itself - one tag, 0x1f5 - is not a command.
        if (tlv.length === 1 && tlv[0].t === 0x1f5) return
        this.noteUnknownTags('to-device', tlv)

        /*
         * A command reaching the appliance does not by itself update HA's displayed state or wake
         * up fast polling - neither a bridge-relayed command (the real app's own, forwarded
         * untouched - see the class comment on the thinq.on('sendData', ...) hook above) nor one
         * this handler issues itself. setProperty() (a command from HA) only writes
         * raw_clip_state and sends the wire frame; it never calls HA.publishProperty or
         * updateQueryInterval - those both live in the read_callback path, which only runs when a
         * real status frame comes back through processTLV(). A relayed command does not even reach
         * setProperty, so raw_clip_state itself is untouched. Either way, HA's displayed state (and
         * the fast/30s poll, which likewise only kicks in once a real read confirms the unit is
         * running) does not catch up until whatever status push the appliance happens to send next
         * - normally seconds away while fast polling is already running, but up to the full
         * 15-minute default interval if the unit had been idle. Measured live 2026-09-18: a
         * Zigbee-button-triggered HA automation set the bedroom AC to "cool", and HA kept showing
         * "off" for close to 2 minutes because the only pushes in between were temperature-only
         * notifies that do not carry the power/mode tags at all - the write itself was confirmed
         * self-issued (its outbound timestamps line up with the automation's own trigger log to
         * the millisecond), not bridge-relayed as first assumed.
         *
         * Rather than trusting the command's value outright (the appliance might still reject it),
         * just pull a fresh confirmed read shortly after - this is the same query() the periodic
         * timer already sends, so it goes through the ordinary processTLV()/read_callback path and
         * publishes for real once the appliance answers, typically in well under a second.
         */
        if (tlv.some(({ t }) => t in this.fields_by_id)) {
            if (this.pendingBridgeRefresh !== undefined) clearTimeout(this.pendingBridgeRefresh)
            this.pendingBridgeRefresh = setTimeout(() => {
                this.pendingBridgeRefresh = undefined
                this.query()
            }, TLVDevice.BRIDGE_REFRESH_DELAY_MS)
        }
    }

    processTLV(tlvArray: TLV.TLV[]) {
        tlvArray.forEach(({ t, v }) => this.processKeyValue(t, v))

        if (!this.isCapsResponse(tlvArray)) this.noteUnknownTags('from-device', tlvArray)

        // capabilities are expected to be received only at the init time
        if (this.query_caps_timeout != undefined && this.isCapsResponse(tlvArray)) {
            log('status', this.id, 'received capability key')
            clearInterval(this.query_caps_timeout)
            this.query_caps_timeout = undefined
            this.capabilityReceived()

            // perform initial values query
            this.query()

            // retry every 15 s until initial values are received
            this.query_values_timeout = setInterval(() => {
                log('status', this.id, 're-trying initial values query due to timeout')
                this.query()
            }, 15 * 1000)
        }

        // values are expected to be received also post-init time
        // but don't process them until capabilities are received
        if (this.query_caps_timeout == undefined && this.isValuesResponse(tlvArray)) {
            if (this.query_values_timeout != undefined) {
                log('status', this.id, 'received initial values key')
                clearInterval(this.query_values_timeout)
                this.query_values_timeout = undefined
            }
            this.valuesReceived()
        }
    }

    processKeyValue(k: number, v: number) {
        this.raw_clip_state[k] = v

        const def = this.fields_by_id[k]
        if (!def) return

        let processed: string | number = v

        if (def.read_xform) {
            let tmp = def.read_xform(processed)
            if (tmp === undefined) return
            processed = tmp
        }

        var doRead = true
        if (def.read_callback) doRead = def.read_callback(processed)
        if (doRead) {
            if (def.readable === false) return

            let fullName = def.comp + '-' + def.name
            this.HA.publishProperty(this.id, fullName, processed)
        }
    }

    // HA-side
    setProperty(prop: string, mqttValue: string) {
        //console.log("HA write", prop, mqttValue)
        const def = this.fields_by_ha[prop]
        if (!def || def.writable === false) {
            console.warn(`Attempting to set property ${prop} which is not writable`)
            return
        }

        let value: string | number | null | undefined
        if (def.write_xform) value = def.write_xform(mqttValue)

        if (value === null || value === undefined) return

        if (typeof value === 'string') value = Number(value)

        var doWrite = true
        if (def.write_callback) doWrite = def.write_callback(value)
        if (doWrite && def.id !== undefined) {
            this.raw_clip_state[def.id] = value

            let attach: number[] = []
            if (Array.isArray(def.write_attach)) attach = def.write_attach
            if (typeof def.write_attach === 'function') attach = def.write_attach(value)

            const write_fields = [def.id].concat(attach)
            const tlvArray = write_fields.map((id) => ({ t: id, v: this.raw_clip_state[id] }))
            //console.log("Sending ", tlvArray)
            this.send([1, 1, 2, 1, 1], tlvArray)
        }
    }
}
