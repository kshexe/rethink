import CST_570004_WW from './devices/CST_570004_WW'
import FX___S from './devices/FX___S'
import MI2D7B from './devices/MI2D7B'
import RD20_S from './devices/RD20_S'
import ST_R_ETH01Y_ from './devices/ST_R_ETH01Y_'
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
}

class Bridge {
    haDevices = new Map<string, HADevice>()
    constructor(
        readonly HA: Connection,
        readonly lgBridge?: LgCloudBridge,
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
