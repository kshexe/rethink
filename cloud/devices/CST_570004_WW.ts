import TLVDevice, { FieldDefinition } from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import { racAirTemp, racPipeTemp } from '@/util/ac_tables'
import log from '@/util/logging'
import HADevice from './base'

type PowerModeChangeHook = () => void
type CheckMode = (arg: number) => boolean

/*
 * LG ceiling-cassette IDU, ThinQ model CST_570004_WW, deviceType 401 (RTK_RTL8720cm),
 * typically installed as several IDUs on one multi-split ODU.
 *
 * It speaks the DualCool AC TLV scheme shared by LG's residential split units: standard tags
 * 0x1f7 power, 0x1f9 operation mode, 0x1fa fan speed, 0x1fd current temperature, 0x1fe target
 * temperature, capability bitmaps, the diagnostic pipe/ODU temperatures and value-tag filter
 * accounting. This handler is not shared with any other model (nothing else in this fork uses
 * this protocol family), so the generic protocol plumbing and this unit's own specifics live
 * together in this one file rather than split across a shared base class.
 */

/*
 * The tags this class handles by name. Tags that appear once, next to the label of the entity
 * they feed, are left as literals there - the surrounding call already says what they are.
 */
const TAG_POWER = 0x1f7
const TAG_MODE = 0x1f9
const TAG_FAN = 0x1fa
const TAG_TEMP_CURRENT = 0x1fd
const TAG_TEMP_TARGET = 0x1fe
const TAG_AUTO_DRY = 0x20e
const TAG_AUTO_DRY_REMAIN = 0x225
const TAG_POWER_W = 0x2b3
const TAG_FILTER_REMAINING = 0x355
const TAG_FILTER_LIFE = 0x356
/* The two tags an IDU may use to report whether it is actually running */
const TAG_IDU_THERMO_ON_OFF = 0x189
const TAG_IDU_RUNNING_ALT = 0x6c
/* Capability tags */
const TAG_CAPS_MODES = 0x2c1
const TAG_CAPS_FANS = 0x2c2
const TAG_CAPS_FEATURE = 0x2cc
const TAG_CAPS_JET_SWING = 0x2cd
const TAG_CAPS_TIMER = 0x2d3
const TAG_CAPS_EEPROM_CRC = 0x2da
const TAG_CAPS_TEMP_MIN = 0x2e1
const TAG_CAPS_TEMP_MAX = 0x2e2

/* Bits of the feature bitmap - reported under 0x2cb on this model, not the 0x2cc most units use */
const CAP_AIR_PURIFY = 0x01
const CAP_ENERGY_SAVE = 0x02
const CAP_AUTO_DRY = 0x04

/*
 * Bits of the jet / positional-swing bitmap, 0x2cd. Not meaningful on this model - see
 * jetSwingCaps() below - but kept for the shared hasJetCool/hasJetHeat/hasSwing* helpers.
 */
const CAP_JET_COOL = 0x01
const CAP_JET_HEAT = 0x02
const CAP_SWING_VERTICAL = 0x04 | 0x10
const CAP_SWING_HORIZONTAL = 0x08 | 0x20

/* Bit of the timer bitmap, 0x2d3 = support.reserve, same key-is-bit-plus-one convention. */
const CAP_SLEEP_TIMER = 0x01

/*
 * The on/off reservation (0x21b/0x21c and the rest of the airState.reservation.* bundle) is
 * deliberately not exposed at all: confirmed 2026-09-10 on a real unit that writing those tags
 * directly over TLV never arms the appliance's own timer (a 2-minute turn-on reservation
 * injected straight onto the wire never fired). The LG app's own reservation screen still works
 * normally through bridge mode, which relays the app's real command sequence to the appliance
 * rather than a raw tag write - there is nothing for this handler to do locally.
 */

/*
 * Test a capability bit. A unit that does not report the bitmap at all reads as having none of
 * its features, which is the useful answer: the entities behind it would have nothing to show.
 */
function capBit(bitmap: number | undefined, mask: number) {
    return bitmap != null && !!(bitmap & mask)
}

/*
 * A mapping between HA labels and wire values, given as [label, wire] pairs. The option list HA is
 * offered and both transform directions are derived from the same list, in the order written, so
 * they cannot drift out of sync.
 *
 * A label may appear more than once. That is how a unit says "these wire values all mean this to
 * the user": the label is offered to HA once, every one of its wire values reads back as it, and
 * the FIRST is what a write sends.
 */
type WireLevels = ReadonlyArray<readonly [string, number]>

function wireMaps(levels: WireLevels) {
    const toWire = new Map<string, number>()
    const labels: string[] = []
    for (const [label, wire] of levels) {
        if (toWire.has(label)) continue // an alias: readable, but not what a write sends
        toWire.set(label, wire)
        labels.push(label)
    }

    return {
        labels,
        toLabel: new Map(levels.map(([label, wire]) => [wire, label])),
        toWire,
    }
}

/* Plain on/off swing, 0x205 / 0x206 - the variant this cassette's vanes actually use */
const SWING_ON_OFF: WireLevels = [
    ['on', 1],
    ['off', 0],
]

/*
 * A single swing axis: which tag drives it, which of HA's two swing attributes it is published
 * as, and the values it takes. A unit with one swing only should use 'swing_mode' - HA renders
 * swing_horizontal_mode as the secondary control.
 */
type SwingAxis = {
    tag: number
    name: 'swing_mode' | 'swing_horizontal_mode'
    levels: WireLevels
    /* tags to re-send alongside the swing write, for units that want the context */
    attach?: number[]
}

/* This unit's vanes: on/off, on their own pair of tags rather than positional ones. */
const SWING_AXES_ON_OFF: SwingAxis[] = [
    { tag: 0x205, name: 'swing_mode', levels: SWING_ON_OFF },
    { tag: 0x206, name: 'swing_horizontal_mode', levels: SWING_ON_OFF },
]

/* The discovery config once the climate component is known to be in it */
type ClimateConfig = DeviceDiscovery & { components: { climate: ClimateComponent } }

/* The transforms of a plain on/off tag driving an HA switch */
const SWITCH_XFORM = {
    write_xform: (val: string) => (val === 'ON' ? 1 : 0),
    read_xform: (raw: number) => (raw ? 'ON' : 'OFF'),
} satisfies Pick<FieldDefinition, 'read_xform' | 'write_xform'>

/*
 * How a switch is wired when a plain 0/1 is not what the tag takes.
 */
type SwitchOptions = {
    /* wire value written for ON, and read back as ON unless readOnValue says otherwise (default 1) */
    onValue?: number
    /* wire value written for OFF (default 0) */
    offValue?: number
    /* wire value that reads back as ON, when the appliance reports something else than it accepts */
    readOnValue?: number
    /* HA entity_category; 'config' unless given, and an explicit undefined means Controls */
    entityCategory?: string
}

function switchXform(options: SwitchOptions) {
    const on = options.onValue ?? 1
    const off = options.offValue ?? 0
    const readOn = options.readOnValue ?? on

    return {
        write_xform: (val: string) => (val === 'ON' ? on : off),
        /*
         * An exact comparison, not truthiness: with onValue 0 (an inverted tag) or a distinct
         * readOnValue, "non-zero" is the wrong question.
         */
        read_xform: (raw: number) => (raw === readOn || raw === on ? 'ON' : 'OFF'),
    } satisfies Pick<FieldDefinition, 'read_xform' | 'write_xform'>
}

export default class Device extends TLVDevice {
    meta: Metadata
    initialValuesReceived: boolean = false
    powerChangeHooks: PowerModeChangeHook[] = []
    powerStatePrev?: boolean
    modeChangeHooks: PowerModeChangeHook[] = []
    modePrev?: string
    /* Symmetric with the two above, for anything derived from the fan speed. */
    fanChangeHooks: PowerModeChangeHook[] = []
    fanPrev?: string | number
    airClean: boolean | undefined
    jetMode: boolean | undefined
    energySave: boolean | undefined
    tlvBlacklistDisableTimer: ReturnType<typeof setTimeout> | undefined
    increasedQueryIntervalTimeout: ReturnType<typeof setTimeout> | undefined
    filterUsedTime: number = 0
    filterLifeTime: number = 0
    filterChangedDate: number = 0
    filterInitialQueryTimeout: ReturnType<typeof setTimeout> | undefined
    filterQueryTimer: ReturnType<typeof setInterval> | undefined
    /* A reset waiting for the query that reads the counter one last time; see the reset button. */
    filterDoReset: boolean = false

    /* HA device name */
    readonly haDeviceName: string = 'LG Air Conditioner'

    /* CST emits its async/query TLV frames with UART header byte 6 = 0xa7 instead of 0x87. */
    isHeaderByte6(byte: number): boolean {
        return byte === 0x87 || byte === 0xa7
    }

    /*
     * Operation modes: CST advertises modes {0,1,2,3} in caps 0x2c1 and reports 0x1f9=3 live for
     * auto - a residential wall unit uses auto=6 (and 4=heat), but this cassette runs on a
     * cooling-only outdoor unit with no heat hardware at all, so the mode list is restricted too.
     */
    readonly modeLevels: WireLevels = [
        ['cool', 0],
        ['dry', 1],
        ['fan_only', 2],
        ['auto', 3],
    ]

    /* Fan speed: 0x1fa scale, six steps. */
    readonly fanLevels: WireLevels = [
        ['auto', 8],
        ['very low', 1],
        ['low', 2],
        ['medium', 4],
        ['high', 6],
        ['power', 7],
    ]

    /*
     * Built on first use rather than in a field initialiser: a base-class field is initialised
     * during super(), before the subclass has assigned the list it would be built from. Both are
     * discarded when capabilities arrive, because that is what narrows them - see capsFiltered().
     */
    private modeMapsCache?: ReturnType<typeof wireMaps>
    private fanMapsCache?: ReturnType<typeof wireMaps>

    get modeMaps() {
        return (this.modeMapsCache ??= wireMaps(this.capsFiltered(this.modeLevels, this.modeCaps(), 'mode')))
    }

    get fanMaps() {
        return (this.fanMapsCache ??= wireMaps(this.capsFiltered(this.fanLevels, this.fanCaps(), 'fan speed')))
    }

    capabilityReceived() {
        /* the lists above are narrowed by these, so anything built from them is now stale */
        this.modeMapsCache = undefined
        this.fanMapsCache = undefined
    }

    /*
     * Which operation modes and fan speeds the unit says it has - bitmaps indexed by the wire
     * value, named support.airState.opMode / support.airState.windStrength (bit N = key N+1).
     */
    modeCaps(): number | undefined {
        return this.raw_clip_state[TAG_CAPS_MODES]
    }

    /*
     * Not narrowed by the 0x2c2 bitmap. This unit reports 469 - wire values 0, 2, 4, 6, 7 and 8 -
     * which agrees with the fan list above on five of six but offers 0 where this says 1. The
     * list is what was derived by driving the appliance, so it wins over an unexplained
     * disagreement about the slowest step; letting the bitmap narrow it would silently drop
     * "very low". Worth settling by writing 0 and seeing whether the panel shows the same step
     * as 1 does.
     */
    fanCaps(): number | undefined {
        return undefined
    }

    /*
     * Narrow a per-model list to what the unit advertises. The list is the vocabulary - which wire
     * value carries which name - and the bitmap is this particular unit's answer about which of
     * them it has.
     *
     * Left alone when the bitmap is absent, zero, or describes none of the declared levels: the
     * bitmaps carry bits well above the level cluster whose meaning is not established, so a
     * bitmap this does not recognise is a reason to publish the model's list unchanged rather than
     * to publish nothing.
     */
    capsFiltered(levels: WireLevels, bitmap: number | undefined, what: string): WireLevels {
        if (!bitmap) return levels

        const kept = levels.filter(([, wire]) => wire < 31 && (bitmap & (1 << wire)) !== 0)
        if (kept.length === 0) return levels

        const dropped = levels.filter((l) => !kept.includes(l))
        if (dropped.length)
            log('status', this.id, `${what}: the unit does not advertise ${dropped.map(([label]) => label).join(', ')}`)
        return kept
    }

    /* hvac modes advertised to HA. 'off' is not a wire value - it is the power tag being 0. */
    get haModes(): string[] {
        return ['off', ...this.modeMaps.labels]
    }

    get haFanModes(): string[] {
        return this.fanMaps.labels
    }

    /*
     * Setting the mode alone is ignored while the unit is powered off - verified on hardware, the
     * official app turns the unit on by sending 0x1f7=1 together with the mode.
     */
    readonly powerOnWithModeWrite = true

    /*
     * Setpoint resolution in degC. 0x1fe is always in half-degrees on the wire; this is only what
     * HA is told it may ask for.
     */
    readonly tempStep: number = 0.5

    /*
     * The mode-dependent switches (air purify, energy saving) are reported only while the unit
     * runs in the matching mode. Marking them optimistic would make HA show two assumed-state
     * buttons rather than a normal toggle - not worth it, see energysave/airclean below.
     */
    readonly modeDependentSwitchOptimistic: boolean = false

    /* A residential DualCool wall unit's 15 h default is not what this cassette takes; the LG
     * app's own 취침예약 picker for it tops out at 7 h, confirmed 2026-09-09 against a real unit. */
    readonly sleepTimerMaxMinutes: number = 7 * 60

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.meta = meta
    }

    cancelPendingWork() {
        /* clearTimeout / clearInterval ignore undefined, so no guard is needed */
        clearTimeout(this.tlvBlacklistDisableTimer)
        this.tlvBlacklistDisableTimer = undefined
        clearTimeout(this.increasedQueryIntervalTimeout)
        this.increasedQueryIntervalTimeout = undefined
        clearTimeout(this.filterInitialQueryTimeout)
        this.filterInitialQueryTimeout = undefined
        clearInterval(this.filterQueryTimer)
        this.filterQueryTimer = undefined

        super.cancelPendingWork()
    }

    processPrivData(cmd: number, buf9: number, data: Buffer) {
        if (cmd == 0x02) this.processFilterData(buf9, data)
    }

    processPrivDataCmdResp(success: boolean, buf1: number, cmd: number, data: Buffer) {
        if (cmd == 0x2) this.processFilterCmdResp(success, data)
    }

    sendFilterQuery() {
        this.sendPrivCommand(0x02, 0x02)
    }

    sendFilterReset() {
        if (!this.filterLifeTime) throw new Error('Filter lifetime not known')

        const now = new Date()
        const date = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate()

        const buf = Buffer.alloc(4 * 3)
        // yes, it's opposite endianness vs read cmd
        buf.writeUInt32BE(this.filterLifeTime, 1 * 4)
        buf.writeUInt32BE(date, 2 * 4)

        log('status', this.id, 'sending filter reset')
        this.sendPrivCommand(0x02, 0x01, buf)
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.some(({ t, v }) => t === TAG_CAPS_EEPROM_CRC)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        return tlvArray.length >= 10 && tlvArray.some(({ t, v }) => t === TAG_POWER)
    }

    /* This class reads most tags straight out of raw_clip_state rather than through addField, so
     * the base set (fields_by_id + structural) misses them. List them here so the frame recorder's
     * unmodelled-tag notes flag only the tags an AC actually reports that nothing here consumes. */
    knownTagIds(): Set<number> {
        const s = super.knownTagIds()
        for (const t of [
            TAG_POWER,
            TAG_MODE,
            TAG_FAN,
            TAG_TEMP_CURRENT,
            TAG_TEMP_TARGET,
            TAG_AUTO_DRY,
            TAG_AUTO_DRY_REMAIN,
            TAG_POWER_W,
            TAG_FILTER_REMAINING,
            TAG_FILTER_LIFE,
            TAG_IDU_THERMO_ON_OFF,
            TAG_IDU_RUNNING_ALT,
            TAG_CAPS_MODES,
            TAG_CAPS_FANS,
            TAG_CAPS_FEATURE,
            TAG_CAPS_JET_SWING,
            TAG_CAPS_TIMER,
            TAG_CAPS_EEPROM_CRC,
            TAG_CAPS_TEMP_MIN,
            TAG_CAPS_TEMP_MAX,
            0x205,
            0x206,
            0x321,
            0x322, // swing axes (SWING_DEFS / addSwingAxis)
            0x323, // jet (addJetField - only wired when the caps bitmap advertises jet)
            0x21f, // display light (addDisplayField, capability-gated)
            0x2f9,
            0x2fa,
            0x2fb, // fan-RPM diagnostics
            0x20d, // energy-save partner tag (addField'd alongside 0x20f)
        ]) {
            s.add(t)
        }
        return s
    }

    valuesReceived() {
        if (this.initialValuesReceived) return
        this.initialValuesReceived = true

        // we want to be informed about all TLV changes - set an empty blacklist
        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })

        // give modem some time to process the command before continuing
        this.tlvBlacklistDisableTimer = setTimeout(() => {
            this.tlvBlacklistDisableTimer = undefined

            if (this.filterStyle() === 'priv') {
                this.initProbeForFilter()
            } else {
                this.initMakeSetConfig()
            }
        }, 500)
    }

    initProbeForFilter() {
        log('status', this.id, 'sending initial filter data query')
        this.sendFilterQuery()

        this.filterInitialQueryTimeout = setTimeout(() => {
            this.filterInitialQueryTimeout = undefined

            log('status', this.id, 'filter data query timeout, assuming no filter')
            this.initMakeSetConfig()
        }, 5 * 1000)
    }

    processFilterData(buf9: number, data: Buffer) {
        if (data.length < 1 + 3 * 4) {
            log('status', this.id, 'filter data too short:', data.length)
            return
        }

        this.filterUsedTime = data.readUInt32LE(1 + 0 * 4)
        this.filterLifeTime = data.readUInt32LE(1 + 1 * 4)
        this.filterChangedDate = data.readUInt32LE(1 + 2 * 4)

        // if this was the initial filter query the device config is ready now
        if (this.filterInitialQueryTimeout != undefined) {
            log('status', this.id, 'received initial filter data')

            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined

            this.initMakeSetConfig()
        } else {
            // if this was not the initial query just update the HA values
            this.publishFilterData()
        }

        /* The answer to the query the reset button sent. Now the counter is current, clear it. */
        if (this.filterDoReset) {
            this.filterDoReset = false
            this.sendFilterReset()
        }
    }

    publishFilterData() {
        const changedDate =
            Math.floor(this.filterChangedDate / 10000)
                .toString()
                .padStart(4, '0') +
            '-' +
            (Math.floor(this.filterChangedDate / 100) % 100).toString().padStart(2, '0') +
            '-' +
            (this.filterChangedDate % 100).toString().padStart(2, '0')

        this.HA.publishProperty(this.id, 'filterused', this.filterUsedTime)
        this.HA.publishProperty(this.id, 'filterlife', this.filterLifeTime)
        this.HA.publishProperty(this.id, 'filterchangeddate', changedDate)
    }

    processFilterCmdResp(success: boolean, data: Buffer) {
        if (!success) {
            log('status', this.id, 'filter reset failed')
            return
        }

        log('status', this.id, 'filter reset okay, re-querying')
        this.sendFilterQuery()
    }

    updateClimateAction() {
        // also updates query interval
        const mode = this.modeMaps.toLabel.get(this.getModeTLV())

        let iduRunning = true
        const iduRunningTLVNum = this.getIDUActionRunningTLVNum()
        if (iduRunningTLVNum != null) {
            iduRunning = this.raw_clip_state[iduRunningTLVNum] !== 0
        }

        const modes2ha: Record<string, string> = {
            cool: 'cooling',
            dry: 'drying',
            fan_only: 'fan',
            heat: 'heating',
        }
        let action: string | undefined = undefined
        let increaseQueryInterval = false
        if (this.getPowerTLV() === 0) {
            action = 'off'
        } else if (mode != null && mode !== 'fan_only' && !iduRunning) {
            action = 'idle'
        } else if (mode === 'auto') {
            // TODO: figure out how to detect the actual running mode in Auto
            // For now, clear the reported action.
            action = 'None'
            increaseQueryInterval = true // assume it is running
        } else {
            action = mode != null ? modes2ha[mode] : undefined
            increaseQueryInterval = action != null && action !== 'fan'
        }

        if (action != null) this.HA.publishProperty(this.id, 'climate-action', action)
        this.updateQueryInterval(increaseQueryInterval)
    }

    updateQueryInterval(increaseQueryInterval: boolean) {
        if (increaseQueryInterval) {
            if (this.increasedQueryIntervalTimeout != undefined) {
                clearTimeout(this.increasedQueryIntervalTimeout)
                this.increasedQueryIntervalTimeout = undefined
            }

            /*
             * When in one of active modes update more frequently
             * since parameters can change rapidly:
             * every a bit less than half a minute.
             *
             * This matches the observed ODU parameter recalculation intervals:
             * compressor Hz - every 30 seconds,
             * EEV openings - every 30 seconds during transient periods.
             */
            this.setQueryInterval((30 - 2) * 1000)
        } else if (this.increasedQueryIntervalTimeout == null) {
            /*
             * Reset to the default interval after 15 minutes,
             * hopefully things returned to steady idle state by this time.
             */
            this.increasedQueryIntervalTimeout = setTimeout(
                () => {
                    this.increasedQueryIntervalTimeout = undefined
                    this.setQueryInterval()
                },
                15 * 60 * 1000,
            )
        }
    }

    getPowerTLV() {
        return this.raw_clip_state[TAG_POWER]
    }

    getModeTLV() {
        return this.raw_clip_state[TAG_MODE]
    }

    getIDUActionRunningTLVNum() {
        if (this.raw_clip_state[TAG_IDU_THERMO_ON_OFF] != null) return TAG_IDU_THERMO_ON_OFF
        if (this.raw_clip_state[TAG_IDU_RUNNING_ALT] != null) return TAG_IDU_RUNNING_ALT

        return undefined
    }

    /* --- capabilities --- */

    /* The feature bitmap is reported under 0x2cb on this model; 0x2cc is not sent at all. */
    featureCaps() {
        return this.raw_clip_state[0x2cb]
    }

    /*
     * 0x2cd is not the jet/positional-swing bitmap here - its value has many unrelated bits set,
     * while the unit has neither jet nor positional swing.
     */
    jetSwingCaps() {
        return 0
    }

    timerCaps() {
        return this.raw_clip_state[TAG_CAPS_TIMER]
    }

    hasAirPurify() {
        return capBit(this.featureCaps(), CAP_AIR_PURIFY)
    }

    hasEnergySave() {
        return capBit(this.featureCaps(), CAP_ENERGY_SAVE)
    }

    hasAutoDry() {
        return capBit(this.featureCaps(), CAP_AUTO_DRY)
    }

    hasJetCool() {
        return capBit(this.jetSwingCaps(), CAP_JET_COOL)
    }

    hasJetHeat() {
        return capBit(this.jetSwingCaps(), CAP_JET_HEAT)
    }

    hasSwingVertical() {
        return capBit(this.jetSwingCaps(), CAP_SWING_VERTICAL)
    }

    hasSwingHorizontal() {
        return capBit(this.jetSwingCaps(), CAP_SWING_HORIZONTAL)
    }

    hasSleepTimer() {
        return capBit(this.timerCaps(), CAP_SLEEP_TIMER)
    }

    /*
     * Which variant of the shared features this unit has. The vanes are driven as plain on/off on
     * 0x205 / 0x206 rather than by position, which 0x2cd does not describe either way.
     */
    swingAxes(): SwingAxis[] {
        return SWING_AXES_ON_OFF
    }

    /*
     * The select variant: 0x20e picks the drying duration (255 = smart) and 0x225 is the number of
     * minutes left in the running cycle - independent of 0x20e, it only changes while drying runs.
     */
    autoDryStyle(): 'none' | 'binary' | 'select' | 'switchLevel' {
        return 'select'
    }

    /*
     * The values of the 'select' form's duration tag.
     */
    readonly autoDryLevels: WireLevels = [
        ['off', 0],
        ['10 min', 1],
        ['30 min', 2],
        ['60 min', 3],
        ['smart', 255],
    ]

    /*
     * How filter usage is accounted. The basic-filter priv-command returns an unpopulated counter
     * here (used=0, life=720) that does not match the app, so read the filter from the value tags
     * instead: 0x356 rated life (constant), 0x355 remaining hours.
     */
    filterStyle(): 'none' | 'priv' | 'valueTags' | 'valueTagsReset' {
        return 'valueTags'
    }

    /* Instantaneous power on 0x2b3, in watts. */
    hasPowerSensor() {
        return this.raw_clip_state[0x2b3] != null
    }

    powerReadXform(raw: number): number {
        return raw
    }

    /*
     * Setpoint range in degC. Read from the cooling range the unit advertises in its capabilities
     * (0x2e1 / 0x2e2).
     * TODO: 0x2e3 - 0x2ec carry the ranges of the other modes
     */
    temperatureRange(): { min: number; max: number } | undefined {
        const min = this.raw_clip_state[TAG_CAPS_TEMP_MIN]
        const max = this.raw_clip_state[TAG_CAPS_TEMP_MAX]
        if (min == null || max == null) return undefined
        return { min: min / 2, max: max / 2 }
    }

    /* Entities that so far only this model has been seen to report. */
    addModelFields(config: DeviceDiscovery) {
        // Display brightness (0x21f, the wall units' "display light"): raw 100/150/200. Those
        // report it inconsistently, here the three levels match what the unit's panel shows.
        this.addValueSelect(config, 'display', 0x21f, 'Display', 'mdi:brightness-6', [
            ['off', 100],
            ['50%', 150],
            ['100%', 200],
        ])

        // 0x23f ("comfort energy saving", distinct from the plain energy saving of 0x20d that
        // is exposed below as "energysave") is deliberately NOT exposed as an entity: confirmed
        // 2026-09-09 on a real unit that toggling it has no observable effect, and the LG app
        // itself has no control for it at all - there is nothing here to verify or act on.

        // Humidity (0x336, raw/10 = %RH). A room measurement, not a diagnostic. Some units
        // report this tag but never anything other than 0 on it - no room ever reads 0% RH, so
        // that is this unit not actually having the sensor rather than a real reading (confirmed
        // 2026-09-09: steady 0 across 40+ min on a real unit). Treating raw 0 as "no value" makes
        // addOptionalSensorField's own presence check skip the entity for units like that, the
        // same way it already does for a tag that is not reported at all.
        this.addOptionalSensorField(
            config,
            0x336,
            'humidity',
            'Humidity',
            undefined,
            {
                device_class: 'humidity',
                unit_of_measurement: '%',
                state_class: 'measurement',
                suggested_display_precision: 0,
                entity_category: undefined,
            },
            (raw) => (raw === 0 ? undefined : Math.round(raw / 10)),
        )

        this.addWindModeSelect(config)
    }

    /*
     * Assemble and install the discovery config. Each step below adds the entities for one
     * concern and is a no-op when the unit does not have it; what decides that - a capability
     * bit, a tag being reported, a per-model answer - is stated at the top of each.
     */
    initMakeSetConfig() {
        const config = this.makeClimateConfig()

        this.addClimateCore(config)
        this.addDiagnosticSensors(config)
        this.addFeatureEntities(config)
        this.addAutoDryEntities(config)
        this.addClimateActionField(config)
        this.addFilterEntities(config)
        this.addPowerSensor(config)
        this.addModelFields(config)

        this.setConfig(config)
        this.startFilterRefresh()
        this.query()
    }

    /*
     * The climate component itself: the setpoint range and resolution, and the mode, fan and
     * (from addClimateCore) swing lists this unit offers.
     */
    makeClimateConfig(): ClimateConfig {
        const range = this.temperatureRange()
        const config: ClimateConfig = allowExtendedType({
            ...HADevice.config(this.meta, { name: this.haDeviceName }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    action_topic: '$this/climate-action',
                    temperature_unit: 'C',
                    temp_step: this.tempStep,
                    precision: this.tempStep,
                    ...(range != null ? { min_temp: range.min, max_temp: range.max } : {}),
                    fan_modes: this.haFanModes,
                    modes: this.haModes,
                } satisfies ClimateComponent,
            },
        })

        return config
    }

    /*
     * Power, mode, fan, both temperatures and the swing axes - the tags every unit on this
     * scheme has, and the only ones that are not conditional.
     */
    addClimateCore(config: ClimateConfig) {
        this.addField(config, {
            id: TAG_TEMP_CURRENT,
            name: 'current_temperature',
            comp: 'climate',
            state_topic: 'topic',
            writable: false,
            read_xform: (raw) => raw / 2,
        })
        this.addField(config, {
            id: TAG_POWER,
            name: 'power',
            comp: 'climate',
            readable: false,
            ...SWITCH_XFORM,
            /*  0x1f7 is not necessary for ON but does not seem to hurt either */
            write_attach: (raw) => (raw ? [TAG_MODE, TAG_FAN, TAG_TEMP_TARGET] : []),
            read_callback: (val) => {
                /*
                 * Update 'mode' instead.
                 *
                 * This is also why a hook that is already on modeChangeHooks does not belong on
                 * powerChangeHooks: mode reads as 'off' while the unit is off and as its actual
                 * mode otherwise, so every power change is a mode change too and a hook on both
                 * lists runs twice for one event.
                 */
                this.processKeyValue(TAG_MODE, this.raw_clip_state[TAG_MODE])

                /* After the mode update, in case a hook depends on it being current. */
                const powerState = val === 'ON'
                if (this.powerStatePrev !== powerState) for (const hook of this.powerChangeHooks) hook()
                this.powerStatePrev = powerState

                return false
            },
        })

        this.addField(config, {
            id: TAG_MODE,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                if (this.getPowerTLV() === 0) return 'off'
                return this.modeMaps.toLabel.get(raw)
            },
            read_callback: (val) => {
                if (typeof val !== 'string') return true
                if (this.modePrev !== val) for (const hook of this.modeChangeHooks) hook()
                this.modePrev = val
                return true
            },
            write_xform: (val) => {
                if (val === 'off') {
                    // Call function power (0x1f7) with value OFF
                    this.setProperty('climate-power', 'OFF')
                    return null
                }
                // Some units ignore a mode write while powered off - the app turns them on by
                // sending 0x1f7=1 together with the mode, so do the same.
                if (this.powerOnWithModeWrite) this.raw_clip_state[TAG_POWER] = 1
                return this.modeMaps.toWire.get(val)
            },
            write_attach: this.powerOnWithModeWrite
                ? [TAG_POWER, TAG_FAN, TAG_TEMP_TARGET]
                : [TAG_FAN, TAG_TEMP_TARGET],
        })

        this.addField(config, {
            id: TAG_FAN,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => this.fanMaps.toLabel.get(raw),
            write_xform: (val) => this.fanMaps.toWire.get(val),
            write_attach: [TAG_MODE, TAG_TEMP_TARGET],
            read_callback: (val) => {
                if (this.fanPrev !== val) for (const hook of this.fanChangeHooks) hook()
                this.fanPrev = val
                return true
            },
        })

        this.addField(config, {
            id: TAG_TEMP_TARGET,
            name: 'temperature',
            comp: 'climate',
            read_xform: (raw) => raw / 2,
            /*
             * HA is told the range and will not offer anything outside it, so the clamp only
             * catches a setpoint arriving from elsewhere - which the unit would reject anyway.
             */
            write_xform: (val) => {
                const range = this.temperatureRange()
                const degC = range == null ? Number(val) : Math.min(Math.max(Number(val), range.min), range.max)
                return Math.round(degC * 2)
            },
            write_attach: [TAG_MODE, TAG_FAN],
        })

        for (const axis of this.swingAxes()) {
            this.addSwingField(config, axis)
        }
    }

    /*
     * Read-only diagnostics, each added only if the unit reports its tag.
     *
     * 0x21f - "display light" value is inverted in some devices, but in some devices it is
     * not - not shown in the ThinQ app either, so it is not exposed here.
     */
    addDiagnosticSensors(config: ClimateConfig) {
        this.addOptionalSensorField(config, 0x221, 'error', 'Error code', 'mdi:alert')
        this.addOptionalSensorField(
            config,
            0x32e,
            'capacity',
            'Capacity nominal',
            undefined,
            {
                device_class: 'power',
                unit_of_measurement: 'kW',
                suggested_display_precision: 1,
            },
            (raw) => (raw !== 0 ? Math.round(raw * 0.293 * 10) / 10 : undefined),
        ) // raw is in kBTU / hour

        /*
         * Whether the IDU will report its EEV opening correctly during its
         * active operation is highly inconsistent between IDUs.
         * For example, from two Standard2 IDUs with 0x690409 software version
         * connected to common ODU one IDU works as expected while the other
         * one reports the EEV opening value of the other Standard2 IDU (?).
         * This may be an ODU firmware bug. On the other hand, another Deluxe
         * IDU connected to the same ODU always reports correct EEV values.
         * None of tested IDUs seem to usually notify by itself when this value changes.
         */
        this.addOptionalSensorField(config, 0x330, 'eev', 'EEV opening', 'mdi:valve', {
            state_class: 'measurement',
            suggested_display_precision: 0,
        })

        /*
         * IDUs send notifications about the updates of the temperatures below
         * at their own pace, sometimes in clusters with other attributes.
         * Deluxe IDUs send notifications noticeably more often than Standard2 IDUs.
         *
         * Pipe temps are sometimes reported as 0 (-100 C) for a moment after a shutdown.
         * Make sure to filter out such updates.
         */
        this.addOptionalSensorTempField(
            config,
            0x2f9,
            'pipeintemp',
            'Pipe liquid temperature',
            'mdi:pipe',
            (raw) => racPipeTemp[255 - raw],
        )
        this.addOptionalSensorTempField(
            config,
            0x2fa,
            'pipeouttemp',
            'Pipe gas temperature',
            'mdi:pipe',
            (raw) => racPipeTemp[255 - raw],
        )

        this.addOptionalSensorTempField(
            config,
            [0x7a, 0x32c],
            'oduhextemp',
            'ODU HEX temperature', // "HEX" = "heat exchanger"
            'mdi:heating-coil',
            (raw) => racPipeTemp[255 - raw],
        )
        this.addOptionalSensorTempField(
            config,
            0x332,
            'oduairtemp',
            'ODU air temperature',
            'mdi:thermometer-lines',
            (raw) => racAirTemp[255 - raw],
        )

        /*
         * [ 0x22a, 0x32f ] - ODU compressor Hz
         * Standard2 IDUs even notify about the former
         * tag changes.
         *
         * But the value seems to be capped at 15 Hz
         * regardless of the actual compressor speed,
         * which makes it of limited usability.
         */

        // 0x2fb is the target fan RPM, while this is the current RPM
        this.addOptionalSensorField(
            config,
            0x331,
            'fanrpm',
            'Fan RPM',
            'mdi:fan',
            {
                state_class: 'measurement',
                unit_of_measurement: 'rpm',
                suggested_display_precision: 0,
            },
            (raw) => raw * 10,
        )
    }

    /*
     * The entities behind the capability bitmaps: air purify, jet, the timers and energy
     * saving. Auto dry is the other bit in that bitmap but has two forms, so it is separate.
     */
    addFeatureEntities(config: ClimateConfig) {
        if (this.hasAirPurify()) {
            this.addModeDependentConfigSwitchField(
                config,
                0x20f,
                'airclean',
                /* Same desc as in lg_thinq */
                'Air purify',
                'mdi:air-purifier',
                'airClean',
            )
        }

        const jetCool = this.hasJetCool()
        const jetHeat = this.hasJetHeat()
        if (jetCool || jetHeat) {
            this.addJetField(config, 0x323, 'jet', 'Jet', 'mdi:wind-power', jetCool, jetHeat)
        }

        if (this.hasSleepTimer()) {
            // 15h by default - displayed in hex as "FH"
            this.addTimerField(config, 0x21a, 'sleeptimer', 'Sleep timer', 'mdi:bed-clock', this.sleepTimerMaxMinutes)
        }

        if (this.hasEnergySave()) {
            // Can be enabled only when running in the cooling mode
            this.addModeDependentConfigSwitchField(
                config,
                0x20d,
                'energysave',
                'Energy saving',
                'mdi:flower',
                'energySave',
                (mode) => mode === this.modeMaps.toWire.get('cool'),
            )
        }
    }

    /*
     * Auto dry, in whichever of its two forms this unit has. See autoDryStyle().
     */
    addAutoDryEntities(config: ClimateConfig) {
        if (this.autoDryStyle() === 'select') {
            /*
             * The select variant: 0x20e picks the drying duration (255 = smart) and 0x225 is the
             * number of minutes left in the running cycle - independent of 0x20e, it only changes
             * while drying runs.
             */
            this.addValueSelect(
                config,
                'autodry_setting',
                TAG_AUTO_DRY,
                'Auto dry',
                'mdi:hair-dryer',
                this.autoDryLevels,
            )

            this.addOptionalSensorField(
                config,
                TAG_AUTO_DRY_REMAIN,
                'autodryremain',
                'Auto dry remaining',
                'mdi:hair-dryer-outline',
                {
                    device_class: 'duration',
                    unit_of_measurement: 'min',
                    suggested_display_precision: 0,
                },
            )
        } else if (this.autoDryStyle() === 'binary') {
            config['components']['autodry'] = allowExtendedType({
                platform: 'binary_sensor',
                unique_id: '$deviceid-autodry',
                name: 'Auto dry',
                icon: 'mdi:hair-dryer',
                entity_category: 'diagnostic',
            })
            this.addField(config, {
                id: TAG_AUTO_DRY,
                name: '',
                comp: 'autodry',
                writable: false,
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            })

            /* here 0x225 is the percentage of the cycle left, not a number of minutes */
            this.addSensorField(
                config,
                TAG_AUTO_DRY_REMAIN,
                'autodryremain',
                'Auto dry remaining',
                'mdi:hair-dryer-outline',
                {
                    unit_of_measurement: '%',
                    suggested_display_precision: 0,
                },
            )
        }
    }

    /*
     * What the unit is actually doing. The tag that reports it only exists on some units; the
     * mode hook recomputes the action either way, power included - see the note on that hook.
     */
    addClimateActionField(config: ClimateConfig) {
        const iduRunningTag = this.getIDUActionRunningTLVNum()
        if (iduRunningTag != null) {
            this.addField(
                config,
                {
                    id: iduRunningTag,
                    name: 'action',
                    comp: 'climate',
                    read_callback: (val) => {
                        this.updateClimateAction()
                        return false
                    },
                },
                false,
            )
        }

        this.modeChangeHooks.push(() => {
            this.updateClimateAction()
        })
    }

    /*
     * Filter usage, in whichever of its two forms this unit has. See filterStyle(). The
     * priv-command form depends on filterLifeTime, which the initial probe has filled in by
     * now if the unit answered it.
     */
    addFilterEntities(config: ClimateConfig) {
        if (this.filterLifeTime) {
            /* All three are published from processFilterData(), not from a tag. */
            this.addPublishedSensor(config, 'filterused', 'Filter used time', {
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                state_class: 'total_increasing',
                entity_category: 'diagnostic',
            })
            this.addPublishedSensor(config, 'filterlife', 'Filter life time', {
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                entity_category: 'diagnostic',
            })
            /* NB: the component key is 'changeddate' while the entity is 'filterchangeddate' */
            this.addPublishedSensor(
                config,
                'filterchangeddate',
                'Filter usage last reset',
                {
                    icon: 'mdi:calendar-refresh-outline',
                    device_class: 'date',
                    entity_category: 'diagnostic',
                },
                'changeddate',
            )

            config['components']['filterreset'] = allowExtendedType({
                platform: 'button',
                unique_id: '$deviceid-filterreset',
                command_topic: '$this/filterreset/set',
                name: 'Reset filter usage',
                icon: 'mdi:calendar-refresh-outline',
                entity_category: 'diagnostic',
            })
            this.fields_by_ha['filterreset'] = {
                name: '',
                comp: '',
                write_xform: (val) => (val === 'PRESS' ? 1 : 0),
                write_callback: (val) => {
                    if (val === 1) {
                        /*
                         * Query first, reset when the answer arrives. These counters are only
                         * refreshed once a day - a query may do an EEPROM write - so resetting
                         * straight away records a usage figure up to 24 hours short of what the
                         * filter actually ran.
                         */
                        this.filterDoReset = true
                        this.sendFilterQuery()
                    }
                    return false
                },
            }
        }

        const valueTags = this.filterStyle() === 'valueTags' || this.filterStyle() === 'valueTagsReset'
        if (valueTags && this.raw_clip_state[TAG_FILTER_LIFE]) {
            /*
             * All of these are published from a read hook on 0x355, the live counter (0x356 is
             * the constant rated life); used = life - remaining, remaining % = remaining / life.
             */
            this.addPublishedSensor(config, 'filter_remaining', 'Filter remaining', {
                icon: 'mdi:air-filter',
                unit_of_measurement: '%',
                state_class: 'measurement',
                suggested_display_precision: 0,
                entity_category: 'diagnostic',
            })
            this.addPublishedSensor(config, 'filter_life', 'Filter life time', {
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                entity_category: 'diagnostic',
            })
            this.addPublishedSensor(config, 'filter_used', 'Filter used time', {
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                state_class: 'total_increasing',
                entity_category: 'diagnostic',
            })
            this.addField(
                config,
                {
                    id: TAG_FILTER_REMAINING,
                    name: '',
                    comp: 'filter_remaining',
                    readable: false,
                    writable: false,
                    read_callback: () => {
                        const life = this.raw_clip_state[TAG_FILTER_LIFE]
                        const remaining = this.raw_clip_state[TAG_FILTER_REMAINING]
                        if (life) {
                            this.HA.publishProperty(this.id, 'filter_remaining', Math.round((remaining / life) * 100))
                            this.HA.publishProperty(this.id, 'filter_used', life - remaining)
                            this.HA.publishProperty(this.id, 'filter_life', life)
                        }
                        return false
                    },
                },
                false,
            )

            /*
             * These tags are not read-only everywhere. On the stand units the official app resets
             * the counter with a plain TLV write of 0 to 0x355, and the appliance answers by
             * reporting 0x355 = 0x356 - a full life again.
             *
             * Wired through fields_by_ha rather than addField because addField would claim
             * fields_by_id[0x355], which the read hook above already owns, and the derived sensors
             * would stop updating. The callback sends the frame itself and returns false so the
             * default write path does not also stamp 0 into raw_clip_state: the appliance's own
             * reply is what should move the sensors, so a reset it ignores leaves HA telling the
             * truth.
             */
            if (this.filterStyle() === 'valueTagsReset') {
                config['components']['filterreset'] = allowExtendedType({
                    platform: 'button',
                    unique_id: '$deviceid-filterreset',
                    command_topic: '$this/filterreset/set',
                    name: 'Reset filter usage',
                    icon: 'mdi:air-filter',
                    entity_category: 'diagnostic',
                })
                this.fields_by_ha['filterreset'] = {
                    name: '',
                    comp: '',
                    write_xform: (val) => (val === 'PRESS' ? 0 : null),
                    write_callback: () => {
                        log('status', this.id, 'resetting the filter counter')
                        this.send([1, 1, 2, 1, 1], [{ t: TAG_FILTER_REMAINING, v: 0 }])
                        return false
                    },
                }
            }
        }
    }

    /*
     * Instantaneous power draw, if the unit reports it.
     */
    addPowerSensor(config: ClimateConfig) {
        if (this.hasPowerSensor()) {
            /* a primary sensor rather than a diagnostic one, hence the entity_category override */
            this.addSensorField(
                config,
                TAG_POWER_W,
                'energy_current',
                'Power',
                undefined,
                {
                    entity_category: undefined,
                    device_class: 'power',
                    unit_of_measurement: 'W',
                    state_class: 'measurement',
                    suggested_display_precision: 0,
                },
                (raw) => this.powerReadXform(raw),
            )
        }
    }

    /*
     * Keep the priv-command filter counters fresh. Only once a day, since a query might do an
     * EEPROM write.
     */
    startFilterRefresh() {
        if (!this.filterLifeTime) return

        this.publishFilterData()

        this.filterQueryTimer = setInterval(
            () => {
                log('status', this.id, 'sending periodic filter data refresh query')
                this.sendFilterQuery()
            },
            24 * 60 * 60 * 1000,
        )
    }

    /*
     * A timer, in minutes. `box` rather than `slider`: a minute-resolution timer is set by typing
     * a number, and an HA number entity has one display mode, so a second slider entity would
     * only be a second row saying the same thing. A dashboard that wants to drag can add the
     * tile card's numeric-input feature, which draws a slider for this entity either way.
     *
     * Minutes rather than hours because that is what the wire carries and what a running timer
     * counts down in - the entity's own value is the time left.
     */
    addTimerField(config: DeviceDiscovery, id: number, name: string, desc: string, icon: string, maxMinutes: number) {
        const comp = {
            platform: 'number',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            device_class: 'duration',
            unit_of_measurement: 'min',
            min: 0,
            max: maxMinutes,
            step: 1,
            mode: 'box',
        } as const
        config['components'][name] = comp

        /*
         * Upon setting this field the device starts counting down and
         * every minute sends the remaining time.
         *
         * The write transform is not optional even though minutes go on the wire as they come in:
         * setProperty drops a write whose field has no write_xform.
         *
         * An emptied number box arrives here as '' (Number('') is 0, so that already worked) or
         * possibly as something non-numeric depending on the HA version - treat anything that
         * isn't a finite number as 0 (cancel the timer) rather than sending NaN onto the wire.
         */
        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => {
                const n = Math.round(Number(val))
                return Number.isFinite(n) ? n : 0
            },
        })
    }

    addJetField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        jetCool: boolean,
        jetHeat: boolean,
    ) {
        const descFull =
            desc + ' ' + (jetCool ? 'cool' : '') + (jetCool && jetHeat ? '/' : '') + (jetHeat ? 'heat' : '')

        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: descFull,
            icon: icon,
            entity_category: 'config',
            optimistic: true,
        }
        config['components'][name] = comp

        const coolWire = this.modeMaps.toWire.get('cool')
        const heatWire = this.modeMaps.toWire.get('heat')

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => {
                this.jetMode = val === 'ON'
                if (!this.jetMode) return 0

                /* ON */
                if (jetCool && this.getModeTLV() === coolWire) return 1
                if (jetHeat && this.getModeTLV() === heatWire) return 2
                return 0
            },
            read_xform: (raw) => {
                if (jetCool && this.getModeTLV() === coolWire && raw == 1) return 'ON'
                if (jetHeat && this.getModeTLV() === heatWire && raw == 2) return 'ON'
                return 'OFF'
            },
            read_callback: (val) => {
                // Ignore read value if not running
                const powerTLV = this.getPowerTLV()
                if (powerTLV === 0 || powerTLV == null) return false

                // Ignore read value if not in the right mode
                if (!((jetCool && this.getModeTLV() === coolWire) || (jetHeat && this.getModeTLV() === heatWire)))
                    return false

                this.jetMode = val === 'ON'
                return true
            },
            write_callback: (val) => {
                /*
                 * Writing '1' in OFF state seem to immediately
                 * power on into the cooling mode, while writing
                 * '2' in the OFF state is ignored.
                 * Be consistent and only allow enabling Jet mode
                 * when running in the right mode.
                 */
                return (
                    this.getPowerTLV() !== 0 &&
                    ((jetCool && this.getModeTLV() === coolWire) || (jetHeat && this.getModeTLV() === heatWire))
                )
            },
        })

        /*
         * This value needs to be written at each power up in heat/cool mode,
         * but in a separate message. The mode hook covers power-up as well - see the power
         * field's read callback - so registering the same write on both lists only sent it twice.
         */
        this.modeChangeHooks.push(() => {
            if (this.jetMode === undefined) return
            this.setProperty(name + '-', this.jetMode ? 'ON' : 'OFF')
        })
    }

    /*
     * A diagnostic sensor fed straight from one tag. addOptionalSensorField picks the first of
     * `ids` the unit actually reports and does nothing if it reports none of them; addSensorField
     * declares the entity unconditionally, for a tag whose presence has already been established.
     */
    addSensorField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        config['components'][name] = allowExtendedType({
            icon: icon ?? undefined,
            platform: 'sensor',
            unique_id: '$deviceid-' + name,
            name: desc,
            entity_category: 'diagnostic',
            ...extra,
        })

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            writable: false,
            read_xform: read_xform,
        })
    }

    addOptionalSensorField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        if (typeof ids === 'number') {
            ids = [ids]
        }

        const id = ids.find(
            (val) =>
                this.raw_clip_state[val] != null &&
                (read_xform == null || read_xform(this.raw_clip_state[val]) != null),
        )
        if (id == null) return

        this.addSensorField(config, id, name, desc, icon, extra, read_xform)
    }

    /*
     * A sensor this class publishes by hand rather than through a TLV field, for values that are
     * computed from several tags or that arrive outside the TLV stream altogether. The caller
     * publishes to `$this/<name>`; `comp` defaults to the same name.
     */
    addPublishedSensor(
        config: DeviceDiscovery,
        name: string,
        desc: string,
        extra: Record<string, unknown>,
        comp: string = name,
    ) {
        config['components'][comp] = allowExtendedType({
            platform: 'sensor',
            unique_id: '$deviceid-' + name,
            state_topic: '$this/' + name,
            name: desc,
            ...extra,
        })
    }

    addOptionalSensorTempField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        this.addOptionalSensorField(
            config,
            ids,
            name,
            desc,
            icon,
            {
                device_class: 'temperature',
                unit_of_measurement: '°C',
                state_class: 'measurement',
                suggested_display_precision: 2,
            },
            read_xform,
        )
    }

    /*
     * A config-category switch component.
     *
     * `entityCategory` decides where HA files the entity on the device page: 'config' puts it under
     * Configuration, 'diagnostic' under Diagnostic, and NO KEY AT ALL under Controls. There is no
     * string meaning Controls, so an everyday control needs the key absent - which is why an
     * explicit `undefined` has to be told apart from the caller saying nothing, and why this
     * spreads an object rather than assigning a value. `entity_category: undefined` is not good
     * enough: JSON.stringify drops it on the wire but the component object the tests read still
     * carries the key.
     */
    addSwitchComponent(
        config: DeviceDiscovery,
        name: string,
        desc: string,
        icon: string,
        optimistic: boolean,
        options: SwitchOptions = {},
    ) {
        const category = 'entityCategory' in options ? options.entityCategory : 'config'
        config['components'][name] = allowExtendedType({
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            ...(category === undefined ? {} : { entity_category: category }),
            ...(optimistic ? { optimistic: true } : {}),
        })
    }

    addConfigSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        options: SwitchOptions = {},
    ) {
        this.addSwitchComponent(config, name, desc, icon, false, options)

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            ...switchXform(options),
        })
    }

    addModeDependentConfigSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        field_name: 'airClean' | 'energySave',
        check_mode?: CheckMode,
    ) {
        this.addSwitchComponent(config, name, desc, icon, this.modeDependentSwitchOptimistic)

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            ...SWITCH_XFORM,
            read_callback: (val) => {
                // Ignore read value if not running
                const powerTLV = this.getPowerTLV()
                if (powerTLV === 0 || powerTLV == null) return false

                // Ignore read value if not in the right mode
                if (check_mode && !check_mode(this.getModeTLV())) return false

                this[field_name] = val === 'ON'
                return true
            },
            write_callback: (val) => {
                this[field_name] = val === 1

                // No need to write the value if not running in the right mode
                return this.getPowerTLV() !== 0 && (!check_mode || check_mode(this.getModeTLV()))
            },
        })

        /*
         * This value needs to be written at each power up, but in a separate message.
         *
         * One list or the other, never both: a mode-dependent switch already gets its write on
         * every power change, because power changes the mode too - see the power field's read
         * callback. A switch that has no check_mode has no mode hook to ride, so it keeps the
         * power one.
         */
        if (check_mode) {
            this.modeChangeHooks.push(() => {
                if (this[field_name] === undefined) return
                this.setProperty(name + '-', this[field_name] ? 'ON' : 'OFF')
            })
        } else {
            this.powerChangeHooks.push(() => {
                if (this[field_name] === undefined) return
                if (this.getPowerTLV() === 0) return
                this.setProperty(name + '-', this[field_name] ? 'ON' : 'OFF')
            })
        }
    }

    /*
     * Register a writable HA select whose options map one-to-one to wire values. The
     * [label, wire] list is the single source of truth - the option list and both the read and
     * write transforms are derived from it, so they can't drift out of sync.
     */
    addValueSelect(config: DeviceDiscovery, comp: string, id: number, name: string, icon: string, levels: WireLevels) {
        if (this.raw_clip_state[id] == null || config.components[comp]) return
        const { labels, toLabel, toWire } = wireMaps(levels)
        config.components[comp] = allowExtendedType({
            platform: 'select',
            unique_id: `$deviceid-${comp}`,
            name,
            icon,
            entity_category: 'config',
            options: labels,
        })
        this.addField(config, {
            id,
            name: '',
            comp,
            read_xform: (raw) => toLabel.get(raw),
            write_xform: (val) => toWire.get(val),
        })
    }

    /*
     * Swing along one axis, as an attribute of the climate component rather than an entity of its
     * own. Same [label, wire] contract as addValueSelect: the mode list HA is offered and both
     * transforms come from the one list.
     */
    addSwingField(config: ClimateConfig, axis: SwingAxis) {
        const { labels, toLabel, toWire } = wireMaps(axis.levels)
        const attr = axis.name === 'swing_mode' ? 'swing_modes' : 'swing_horizontal_modes'
        config['components']['climate'][attr] = labels
        this.addField(config, {
            id: axis.tag,
            name: axis.name,
            comp: 'climate',
            read_xform: (raw) => toLabel.get(raw),
            write_xform: (val) => toWire.get(val),
            ...(axis.attach != null ? { write_attach: axis.attach } : {}),
        })
    }

    /*
     * Wind mode (comfort airflow): five mutually-exclusive one-hot flags -
     * 0x3d6=manner, 0x3d7=long power, 0x291=study, 0x290=auto temp, all-0=off.
     * Expose as a single select. Only effective in cool mode. Reads derive the mode from
     * whichever flag is set (via a read hook on each); the write is handled in setProperty.
     */
    addWindModeSelect(config: DeviceDiscovery) {
        if (this.raw_clip_state[0x3d6] == null || config.components['wind_mode']) return

        config.components['wind_mode'] = allowExtendedType({
            platform: 'select',
            unique_id: '$deviceid-wind_mode',
            name: 'Wind mode',
            icon: 'mdi:weather-windy',
            entity_category: 'config',
            options: ['off', 'manner', 'long power', 'study', 'auto temp'],
            state_topic: '$this/wind_mode',
            command_topic: '$this/wind_mode/set',
        })
        for (const id of Device.WIND_FLAGS) {
            this.addField(
                config,
                {
                    id,
                    name: `flag_${id.toString(16)}`,
                    comp: 'wind_mode',
                    readable: false,
                    writable: false,
                    read_callback: () => {
                        this.HA.publishProperty(this.id, 'wind_mode', this.windModeFromState())
                        return false
                    },
                },
                false,
            )
        }
    }

    // Wind-mode one-hot flags: 0x290 auto temp, 0x291 study, 0x3d5 release, 0x3d6 manner,
    // 0x3d7 long power. Exactly one is 1 at a time; "off" is all flags 0.
    static readonly WIND_FLAGS = [0x290, 0x291, 0x3d5, 0x3d6, 0x3d7]
    static readonly WIND_TO_FLAG: Record<string, number | undefined> = {
        manner: 0x3d6,
        'long power': 0x3d7,
        study: 0x291,
        'auto temp': 0x290,
        off: undefined,
    }

    windModeFromState(): string {
        if (this.raw_clip_state[0x3d6]) return 'manner'
        if (this.raw_clip_state[0x3d7]) return 'long power'
        if (this.raw_clip_state[0x291]) return 'study'
        if (this.raw_clip_state[0x290]) return 'auto temp'
        return 'off'
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'wind_mode') {
            const on = Device.WIND_TO_FLAG[mqttValue]
            // select one flag exclusively: chosen=1, everything else (incl. 0x3d5 release)=0
            const tlv = Device.WIND_FLAGS.map((id) => ({ t: id, v: id === on ? 1 : 0 }))
            for (const { t, v } of tlv) this.raw_clip_state[t] = v
            this.send([1, 1, 2, 1, 1], tlv)
            return
        }
        super.setProperty(prop, mqttValue)
    }
}
