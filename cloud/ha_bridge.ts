import CST_570004_WW from './devices/CST_570004_WW'
import FX___S from './devices/FX___S'
import MI2D7B from './devices/MI2D7B'
import RD20_S from './devices/RD20_S'
import ST_R_ETH01Y_ from './devices/ST_R_ETH01Y_'
import H01 from './devices/H01'
import Fridge_2REF21EBNSX_3 from './devices/2REF21EBNSX_3'
import ML32PWFOTA from './devices/ML32PWFOTA'
import { Device as T2Device } from './thinq2/device'
import { type Connection } from './homeassistant'
import HADevice from './devices/base'
import { type Metadata } from './thinq'
import { AnyDevice } from './devmgr'
import { type Bridge as LgCloudBridge } from '@/bridge'
import { type ControlState } from './control_state'

type T2Factory = new (HA: Connection, thinq: T2Device, metadata: Metadata) => HADevice

const t2deviceTypes: Record<string, T2Factory> = {
    CST_570004_WW, // LG ceiling-cassette IDU (multi-split, deviceType 401); DualCool TLV, self-contained handler
    FX___S, // LG front-load washer sold in Korea (deviceType 201, tunnelled 0xEC state frames)
    MI2D7B, // LG MiniWash (미니워시, deviceType 201) - power on/off only so far, see MI2D7B.ts
    RD20_S, // LG dryer (건조기, deviceType 202) - power on/off only so far, see RD20_S.ts
    ['ST_R_ETH01Y_']: ST_R_ETH01Y_, // LG Styler (스타일러, deviceType 203) - power/course/start, see ST_R_ETH01Y_.ts
    ['H01']: H01, // LG dishwasher (식기세척기) - power on/off only so far, see H01.ts
    ['2REF21EBNSX_3']: Fridge_2REF21EBNSX_3, // LG fridge (냉장고) - fridge/freezer temp + express freeze, see 2REF21EBNSX_3.ts
    ['ML32PWFOTA']: ML32PWFOTA, // LG combi oven (광파오븐) - course select + cook time + send/cancel, never start; see ML32PWFOTA.ts
}

class Bridge {
    haDevices = new Map<string, HADevice>()

    /*
     * Devices the management panel has deliberately put into read-only mode: their state still
     * flows to Home Assistant as normal (nothing here touches processAABB/publishProperty), but HA
     * never even gets a control entity for them to begin with (see applyControlFilter below) -
     * meant for watching a food-safety-critical appliance (fridge, kimchi fridge) settle in before
     * trusting it with real control, without a switch sitting in the dashboard that looks live but
     * silently does nothing.
     *
     * Persisted through `controlState` when one is given (real startup always gives one - see
     * rethink-cloud.ts; tests mostly don't, and get in-memory-only behavior instead).
     */
    private controlDisabled: Set<string>

    constructor(
        readonly HA: Connection,
        readonly lgBridge?: LgCloudBridge,
        readonly controlState?: ControlState,
    ) {
        this.controlDisabled = new Set(controlState?.getDisabledDevices() ?? [])

        HA.on('discovery', () => {
            this.haDevices.forEach((ha) => ha.publishConfig())
        })
        HA.on('setProperty', (id: string, prop: string, value: string) => {
            // Defense in depth: with applyControlFilter in place HA should have no entity left to
            // send this from, but a client that hasn't picked up the discovery update yet (a
            // cached dashboard, a race on toggle) could still have one queued.
            if (this.controlDisabled.has(id)) return
            const ha = this.haDevices.get(id)
            if (ha) ha.setProperty(prop, value)
        })

        // The owner's real name for the appliance (the same one the LG app shows) is only known
        // once the LG account is linked (bridge mode, see management/index.ts's login flow) - wrap
        // publishConfig() so it rides along on every publish, whenever that turns out to be,
        // instead of a static "LG Air Conditioner"/"LG Washer"/etc.
        this.lgBridge?.on('namesChanged', () => this.refreshAllNames())
    }

    private refreshAllNames() {
        if (!this.lgBridge) return
        for (const [id, hadevice] of this.haDevices) {
            const name = this.lgBridge.name(id)
            if (name && hadevice.config && hadevice.config.device.name !== name) {
                hadevice.config.device.name = name
                hadevice.publishConfig()
            }
        }
    }

    /*
     * Wraps publishConfig() so a read-only device's discovery payload never lists a control
     * component (switch/select/number/button/... - anything with a command_topic) in the first
     * place, rather than publishing one HA would create and then silently ignore every command
     * sent to it. HA's device-based MQTT discovery removes an entity whose component drops out of
     * a later publish, so toggling this back on brings the controls back the same way.
     *
     * Applied before applyDeviceName so that wrapper (device name) ends up outermost: it mutates
     * hadevice.config.device.name first, then calls down into this one, which reads that already-
     * corrected config. Order matters here - the other way around, a disabled device's filtered
     * publish would go out with the name renaming not yet applied.
     */
    private applyControlFilter(id: string, hadevice: HADevice) {
        const originalPublishConfig = hadevice.publishConfig.bind(hadevice)
        hadevice.publishConfig = () => {
            if (!this.controlDisabled.has(id) || !hadevice.config) {
                originalPublishConfig()
                return
            }

            const fullConfig = hadevice.config
            hadevice.config = {
                ...fullConfig,
                components: Object.fromEntries(
                    Object.entries(fullConfig.components).filter(([, comp]) => !('command_topic' in comp)),
                ),
            }
            try {
                originalPublishConfig()
            } finally {
                hadevice.config = fullConfig
            }
        }

        if (hadevice.config) hadevice.publishConfig()
    }

    private applyDeviceName(id: string, hadevice: HADevice) {
        const lgBridge = this.lgBridge
        if (!lgBridge) return

        const originalPublishConfig = hadevice.publishConfig.bind(hadevice)
        hadevice.publishConfig = () => {
            const name = hadevice.config && lgBridge.name(id)
            if (name) hadevice.config!.device.name = name
            originalPublishConfig()
        }

        if (hadevice.config) hadevice.publishConfig()
    }

    newDevice(thinqdev: AnyDevice) {
        const meta = thinqdev.meta
        const oldDevice = this.haDevices.get(thinqdev.id)
        if (oldDevice) oldDevice.drop()

        const devclass = t2deviceTypes[meta.modelId]
        const hadevice = devclass ? new devclass(this.HA, thinqdev, meta) : undefined

        if (!hadevice) {
            console.warn(`${thinqdev.platform} device type ${meta.modelId} unknown`)
            return
        }

        /*
         * A ThinQ appliance may open its replacement MQTT connection before the old one's close
         * event fires - notably right after a washer powers itself off and back on. The new
         * handler publishes online during start() below, so dropping the superseded handler here
         * would only cost every entity a brief unavailable -> available flicker for no reason: the
         * map entry is about to be replaced. Its timers/listeners still need releasing though.
         */
        this.haDevices.get(thinqdev.id)?.cancelPendingWork()

        this.haDevices.set(thinqdev.id, hadevice)
        thinqdev.on('close', () => this.dropDevice(hadevice))

        this.applyControlFilter(thinqdev.id, hadevice)
        if (this.lgBridge) this.applyDeviceName(thinqdev.id, hadevice)

        // hadevice.publishConfig() not needed anymore, will usually happen in the devclass constructor - or later
        hadevice.start()
    }

    isControlEnabled(id: string) {
        return !this.controlDisabled.has(id)
    }

    setControlEnabled(id: string, enabled: boolean) {
        if (enabled) this.controlDisabled.delete(id)
        else this.controlDisabled.add(id)
        this.controlState?.setDisabledDevices([...this.controlDisabled])
        this.haDevices.get(id)?.publishConfig()
    }

    dropDevice(ha: HADevice) {
        if (this.haDevices.get(ha.id) === ha) {
            this.haDevices.delete(ha.id)
            ha.drop()
        }
    }
}

export default Bridge
