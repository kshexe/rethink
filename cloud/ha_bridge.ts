import CST_570004_WW from './devices/CST_570004_WW'
import FX___S from './devices/FX___S'
import MI2D7B from './devices/MI2D7B'
import RD20_S from './devices/RD20_S'
import ST_R_ETH01Y_ from './devices/ST_R_ETH01Y_'
import H01 from './devices/H01'
import Fridge_2REF21EBNSX_3 from './devices/2REF21EBNSX_3'
import ML32PWFOTA from './devices/ML32PWFOTA'
import KimchiFridge_3REK2G03VI200S_2 from './devices/3REK2G03VI200S_2'
import { Device as T2Device } from './thinq2/device'
import { type Connection } from './homeassistant'
import HADevice from './devices/base'
import AABBDevice from './devices/aabb_device'
import { type Metadata } from './thinq'
import { AnyDevice } from './devmgr'
import { type Bridge as LgCloudBridge } from '@/bridge'

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
    ['3REK2G03VI200S_2']: KimchiFridge_3REK2G03VI200S_2, // LG kimchi fridge (김치냉장고) - per-compartment storage mode + one-touch deodorize + door, see 3REK2G03VI200S_2.ts
}

class Bridge {
    haDevices = new Map<string, HADevice>()

    // A close-then-(re)register pair within disconnectGraceMs of each other never reaches HA as
    // an availability flicker - see dropDevice()'s own comment for the case this covers, and
    // newDevice()'s for the other (already-handled) ordering.
    pendingDrops = new Map<string, { device: HADevice; timer: ReturnType<typeof setTimeout> }>()

    constructor(
        readonly HA: Connection,
        readonly lgBridge?: LgCloudBridge,
        // Overridable only so a test can use a short wait instead of actually waiting out the
        // real default - see newDevice() for what this bounds.
        private readonly nameLookupTimeoutMs = 5000,
        // Also overridable for the same reason - see dropDevice().
        private readonly disconnectGraceMs = 2000,
    ) {
        HA.on('discovery', () => {
            this.haDevices.forEach((ha) => ha.publishConfig())
        })
        HA.on('setProperty', (id: string, prop: string, value: string) => {
            const ha = this.haDevices.get(id)
            if (ha) ha.setProperty(prop, value)
        })

        // The owner's real name for the appliance (the same one the LG app shows) is only known
        // once the LG account is linked (bridge mode, see management/index.ts's login flow) - wrap
        // publishConfig() so it rides along on every publish, whenever that turns out to be,
        // instead of a static "LG Air Conditioner"/"LG Washer"/etc.
        this.lgBridge?.on('namesChanged', () => this.refreshAllNames())

        // A management-panel toggle flips AABBDevice.autoAck on the live handler directly - no
        // restart needed, so this takes effect on the very next frame the appliance sends.
        this.lgBridge?.on('autoAckChanged', (id, enabled) => {
            const hadevice = this.haDevices.get(id)
            if (hadevice instanceof AABBDevice) hadevice.setAutoAck(enabled)
        })
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

        // Every AABBDevice subclass hardcodes autoAck:false at its own super() call - apply
        // whatever the panel has actually chosen for this device instead, the same way a fresh
        // reconnect (this same code path) needs to pick a previously-saved choice back up.
        if (hadevice instanceof AABBDevice && this.lgBridge) hadevice.setAutoAck(this.lgBridge.autoAck(thinqdev.id))

        /*
         * A ThinQ appliance may open its replacement MQTT connection before the old one's close
         * event fires - notably right after a washer powers itself off and back on. The new
         * handler publishes online during start() below, so dropping the superseded handler here
         * would only cost every entity a brief unavailable -> available flicker for no reason: the
         * map entry is about to be replaced. Its timers/listeners still need releasing though - and
         * this is the *only* thing done to it: no drop(), so no availability publish, ever, for a
         * device this bridge is about to immediately replace.
         */
        this.haDevices.get(thinqdev.id)?.cancelPendingWork()

        // The other ordering: the old connection's close already fired and dropDevice() below
        // scheduled the actual drop (offline publish + map removal) for after disconnectGraceMs,
        // in case this was a real disconnect rather than a reconnect. It wasn't - cancel it.
        const pending = this.pendingDrops.get(thinqdev.id)
        if (pending) {
            clearTimeout(pending.timer)
            this.pendingDrops.delete(thinqdev.id)
        }

        this.haDevices.set(thinqdev.id, hadevice)

        // NOTE: we don't unset this when dropping the device, we assume that the device will never be used
        // outside of the bridge or outlive it.
        thinqdev.managed = true
        thinqdev.on('close', () => this.dropDevice(hadevice))

        if (this.lgBridge) this.applyDeviceName(thinqdev.id, hadevice)

        // hadevice.publishConfig() not needed anymore, will usually happen in the devclass constructor - or later
        hadevice.start()
    }

    /*
     * Runs on a device's own 'close' - which fires for a genuine disconnect just as much as for
     * the appliance's own reconnect (a washer's brief power-cycle, a flaky connection recovering
     * on its own): the two look identical from here, and only the *next* newDevice() call for
     * this id - or its absence - tells them apart. Publishing offline immediately would flicker
     * every entity for the reconnect case, which is the common one; waiting disconnectGraceMs
     * before actually dropping costs the genuine-disconnect case that same delay before HA shows
     * it, which is the one case this ever matters for.
     */
    dropDevice(ha: HADevice) {
        if (this.haDevices.get(ha.id) !== ha) return

        const previous = this.pendingDrops.get(ha.id)
        if (previous) clearTimeout(previous.timer)

        const pending: { device: HADevice; timer: ReturnType<typeof setTimeout> } = {
            device: ha,
            timer: setTimeout(() => {
                if (this.haDevices.get(ha.id) === ha) {
                    this.haDevices.delete(ha.id)
                    ha.drop()
                }
                if (this.pendingDrops.get(ha.id) === pending) this.pendingDrops.delete(ha.id)
            }, this.disconnectGraceMs),
        }
        this.pendingDrops.set(ha.id, pending)
    }
}

export default Bridge
