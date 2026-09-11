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

/*
 * The account's own device name follows a consistent "<room><appliance type>" pattern in this
 * household (거실에어컨, 안방에어컨, 냉장고, 김치냉장고, 세탁기, 건조기, ...) - one word for
 * appliances that never move room to room (fridge, washer, ...), two for the ones that come in
 * more than one unit (the 4 identical air conditioners). Stripping the appliance-type suffix, when
 * the name ends with one, recovers just the room ("거실", "안방") to use as HA's `suggested_area` -
 * this groups the device's entities into that Area (creating it on first discovery if it doesn't
 * already exist) without needing a Korean-vs-romanized decision for entity_id (see the file
 * header's entity-naming saga): the device's own `name` is untouched, still the account's real
 * name, still HA's own doing when it slugifies that into entity_id.
 *
 * A name that does not end with any of these (a device type not in this list, or one the account
 * happens to name differently) is left alone - no suggested_area is set for it, exactly as if this
 * feature did not exist for that device.
 */
const APPLIANCE_TYPE_SUFFIXES = [
    '에어컨', // air conditioner (CST_570004_WW) - the one type in this household with >1 unit/room
    '김치냉장고', // kimchi fridge - checked before 냉장고 since it ends with the same word
    '냉장고', // fridge
    '세탁기', // washer
    '건조기', // dryer
    '미니워시', // mini wash
    '스타일러', // styler
    '식기세척기', // dishwasher
    '광파오븐', // combi oven
]

function roomFromDeviceName(name: string): string | undefined {
    for (const suffix of APPLIANCE_TYPE_SUFFIXES) {
        // >= , not >: an exact match (name === suffix, e.g. "김치냉장고" against its own listed
        // suffix) must stop here with no room, not fall through to also match a shorter listed
        // suffix that happens to be a tail of this one (plain "냉장고", checked right after it).
        if (name.length >= suffix.length && name.endsWith(suffix)) {
            const room = name.slice(0, name.length - suffix.length)
            return room === '' ? undefined : room
        }
    }
    return undefined
}

class Bridge {
    haDevices = new Map<string, HADevice>()

    constructor(
        readonly HA: Connection,
        readonly lgBridge?: LgCloudBridge,
        // Overridable only so a test can use a short wait instead of actually waiting out the
        // real default - see newDevice() for what this bounds.
        private readonly nameLookupTimeoutMs = 5000,
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
    }

    private refreshAllNames() {
        if (!this.lgBridge) return
        for (const [id, hadevice] of this.haDevices) {
            const name = this.lgBridge.name(id)
            if (name && hadevice.config && hadevice.config.device.name !== name) {
                hadevice.config.device.name = name
                hadevice.config.device.suggested_area = roomFromDeviceName(name)
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
            if (name) {
                hadevice.config!.device.name = name
                hadevice.config!.device.suggested_area = roomFromDeviceName(name)
            }
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

        if (this.lgBridge) this.applyDeviceName(thinqdev.id, hadevice)

        // hadevice.publishConfig() not needed anymore, will usually happen in the devclass constructor - or later
        hadevice.start()
    }

    dropDevice(ha: HADevice) {
        if (this.haDevices.get(ha.id) === ha) {
            this.haDevices.delete(ha.id)
            ha.drop()
        }
    }
}

export default Bridge
