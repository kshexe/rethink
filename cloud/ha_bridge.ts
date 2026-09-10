import CST_570004_WW from './devices/CST_570004_WW'
import FX___S from './devices/FX___S'
import MI2D7B from './devices/MI2D7B'
import RD20_S from './devices/RD20_S'
import ST_R_ETH01Y_ from './devices/ST_R_ETH01Y_'
import H01 from './devices/H01'
import Fridge_2REF21EBNSX_3 from './devices/2REF21EBNSX_3'
import ML32PWFOTA from './devices/ML32PWFOTA'
import { Device as T2Device } from './thinq2/device'
import { type Connection, type DeviceDiscovery } from './homeassistant'
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
        // Overridable only so a test can use a short wait instead of actually waiting out the
        // real default - see newDevice() for what this bounds.
        private readonly nameLookupTimeoutMs = 5000,
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
     * component (switch/select/number/button/... - anything with a command_topic), rather than
     * publishing one HA would create and then silently ignore every command sent to it.
     *
     * Simply omitting a component from a later publish is NOT enough on its own - confirmed
     * against a real HA instance 2026-09-10 (the filtered payload rethink sent was byte-for-byte
     * correct, captured straight off the MQTT broker, and HA kept the entity anyway) and against
     * HA's own docs: omitting a component reads as "unchanged", not "removed". Removing one for
     * real needs two publishes in a row - first an update where that component is reduced to just
     * `{platform: ...}` (an explicit "this is now empty" marker, still naming the component so HA
     * knows which unique_id it refers to), then a normal publish that omits it entirely. Adding a
     * component back (re-enabling) doesn't need any of this - a plain publish that includes it
     * again is a normal discovery update either way.
     *
     * Applied before applyDeviceName so that wrapper (device name) ends up outermost: it mutates
     * hadevice.config.device.name first, then calls down into this one, which reads that already-
     * corrected config. Order matters here - the other way around, a disabled device's filtered
     * publish would go out with the name renaming not yet applied.
     */
    private applyControlFilter(id: string, hadevice: HADevice) {
        const originalPublishConfig = hadevice.publishConfig.bind(hadevice)
        const publishWith = (components: DeviceDiscovery['components']) => {
            const fullConfig = hadevice.config!
            hadevice.config = { ...fullConfig, components }
            try {
                originalPublishConfig()
            } finally {
                hadevice.config = fullConfig
            }
        }

        hadevice.publishConfig = () => {
            if (!this.controlDisabled.has(id) || !hadevice.config) {
                originalPublishConfig()
                return
            }

            const controlEntries = Object.entries(hadevice.config.components).filter(
                ([, comp]) => 'command_topic' in comp,
            )
            if (controlEntries.length > 0) {
                publishWith({
                    ...hadevice.config.components,
                    ...Object.fromEntries(
                        controlEntries.map(([key, comp]) => [
                            key,
                            { platform: comp.platform, unique_id: comp.unique_id },
                        ]),
                    ),
                })
            }

            publishWith(
                Object.fromEntries(
                    Object.entries(hadevice.config.components).filter(([, comp]) => !('command_topic' in comp)),
                ),
            )
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

    /*
     * Home Assistant hands out an entity's entity_id (the "lg_fridge_door_open" in
     * binary_sensor.lg_fridge_door_open) the moment it first sees that entity, from whatever
     * device name the config carried at that instant - and never revisits it on a later config
     * update, even once the real name arrives and the *friendly* name updates correctly. A device
     * this bridge has already seen before (deviceNames is seeded from disk - see bridge/index.ts)
     * resolves lgBridge.name() synchronously and skips this entirely; this only matters for a
     * device connecting for the very first time ever, whose name has to be asked for over the
     * network. A bounded wait here, before that device's very first publishConfig() ever happens,
     * is the only way to give it a shot at "냉장고" instead of the static "LG Fridge" fallback -
     * once that fallback has been published even once, it's stuck in every entity_id forever.
     */
    async newDevice(thinqdev: AnyDevice) {
        const meta = thinqdev.meta
        const oldDevice = this.haDevices.get(thinqdev.id)
        if (oldDevice) oldDevice.drop()

        if (this.lgBridge && !this.lgBridge.name(thinqdev.id)) {
            await Promise.race([
                this.lgBridge.refreshNames(),
                new Promise((resolve) => setTimeout(resolve, this.nameLookupTimeoutMs)),
            ])
        }

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
