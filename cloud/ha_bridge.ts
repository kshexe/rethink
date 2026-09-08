import POT_056905_WW from './devices/POT_056905_WW'
import WTDN3 from './devices/WTDN3'
import RAC_056905_WW from './devices/RAC_056905_WW'
import WIN_056905_WW from './devices/WIN_056905_WW'
import Dev_2REF11EIDA__4 from './devices/2REF11EIDA__4'
import Dev_2REF11EBIVPC4 from './devices/2REF11EBIVPC4'
import Dev_2RES1VE61NFA2 from './devices/2RES1VE61NFA2'
import Dev_2REB1GLVB1__2 from './devices/2REB1GLVB1__2'
import Dev_2RES1VE600FWC from './devices/2RES1VE600FWC'
import Dev_STUDIO_HOOD from './devices/STUDIO_HOOD'
import Y_V8_Y___W_B32QEUK from './devices/Y_V8_Y___W.B32QEUK'
import F_V8_Y___W_B_2QEUK from './devices/F_V8_Y___W.B_2QEUK'
import Y_V8_F___W_B_2QEUK from './devices/Y_V8_F___W.B_2QEUK'
import F_V__F___W_B_1QEUK from './devices/F_V__F___W.B_1QEUK'
import F_VB_F___W_B_2QEUK from './devices/F_VB_F___W.B_2QEUK'
import VCDWL2QEUK from './devices/VCDWL2QEUK'
import T1789EFH_F from './devices/T1789EFH_F'
import RV13U6AM8W_D_US_WIFI from './devices/RV13U6AM8W_D_US_WIFI'
import F3L2CYU__ from './devices/F3L2CYU__'
import F3L7CYK5W_US_WIFI from './devices/F3L7CYK5W_US_WIFI'
import RV13B6BSD_D_US_WIFI from './devices/RV13B6BSD_D_US_WIFI'
import RV13B6ES_D_US_WIFI from './devices/RV13B6ES_D_US_WIFI'
import WTL_FXU_BDV_NA_01 from './devices/WTL_FXU_BDV_NA_01'
import DHUM_056905_WW from './devices/DHUM_056905_WW'
import ST_B_E4H01Y_APL from './devices/ST_B_E4H01Y_APL'
import CST_570004_WW from './devices/CST_570004_WW'
import FX___S from './devices/FX___S'
import { Device as T1Device } from './thinq1/device'
import { Device as T2Device } from './thinq2/device'
import { type Connection } from './homeassistant'
import HADevice from './devices/base'
import { type Metadata } from './thinq'
import { AnyDevice } from './devmgr'
import { type Bridge as LgCloudBridge } from '@/bridge'

const BRIDGE_ENABLED_PROP = 'bridge_enabled'
const BRIDGE_DEVICE_TYPE_PROP = 'bridge_device_type'

type T1Factory = new (HA: Connection, thinq: T1Device, metadata: Metadata) => HADevice
type T2Factory = new (HA: Connection, thinq: T2Device, metadata: Metadata) => HADevice

const t1deviceTypes: Record<string, T1Factory> = {
    WTDN3,
}

const t2deviceTypes: Record<string, T2Factory> = {
    POT_056905_WW,
    RAC_056905_WW,
    ['RAC_0B0001_WW']: RAC_056905_WW, // a different European variant (deviceType 401, RTK_RTL8720cm), same TLV handler
    WIN_056905_WW,
    ['2REF11EIDA__4']: Dev_2REF11EIDA__4,
    ['2REF11EBIVPC4']: Dev_2REF11EBIVPC4,
    ['2RES1VE61NFA2']: Dev_2RES1VE61NFA2,
    ['2REB1GLVB1__2']: Dev_2REB1GLVB1__2,
    ['2RES1VE600FWC']: Dev_2RES1VE600FWC,
    ['STUDIO_HOOD']: Dev_STUDIO_HOOD,
    ['Y_V8_Y___W.B32QEUK']: Y_V8_Y___W_B32QEUK,
    ['F_V7_Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK, // NOTE: we reuse F_V8_Y___W_B_2QEUK as the models appear to be compatible
    ['F_V7_Y___W.B__QEUK']: F_V8_Y___W_B_2QEUK, // LG F2V5PS0W front-load washer - confirmed working, status/course/spin/temp/energy/remaining_time all decode correctly against a real unit
    ['F_V8_Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK,
    ['Y_V8_F___W.B_2QEUK']: Y_V8_F___W_B_2QEUK,
    ['F_V__Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK, // NOTE: we reuse F_V8_Y___W_B_2QEUK as the models appear to be compatible
    ['VCDWL2QEUK']: VCDWL2QEUK, // LG F4X7511TWS front-load washer (matched on modelId VCDWL2QEUK)
    ['F_V__F___W.B_1QEUK']: F_V__F___W_B_1QEUK,
    // FV1413H2BA front-load washer SoftAP model F_VA_F___W.B__QEUK (deviceType 201)
    ['F_VA_F___W.B__QEUK']: F_V__F___W_B_1QEUK,
    ['F_VB_F___W.B_2QEUK']: F_VB_F___W_B_2QEUK, // LG CV74J7S2QA washer/dryer combo
    ['T1789EFH_F']: T1789EFH_F, // LG WT7300CW top-loading washer
    ['RV13U6AM8W_D_US_WIFI']: RV13U6AM8W_D_US_WIFI, // LG DLE7300WE dryer
    ['F3L2CYU__']: F3L2CYU__, // LG front-load washer
    ['F3L7CYK5W_US_WIFI']: F3L7CYK5W_US_WIFI, // LG front-load washer, same record layout as F3L2CYU__ but
    // a different course table and two extra option bits, so it needs its own handler rather than an alias
    ['RV13B6BSD_D_US_WIFI']: RV13B6BSD_D_US_WIFI, // LG electric dryer
    ['RV13B6ES_D_US_WIFI']: RV13B6ES_D_US_WIFI, // LG electric dryer, same frame layout as RV13B6BSD but
    // Wrinkle Care sits in a different bitfield, so it needs its own handler rather than an alias
    WTL_FXU_BDV_NA_01, // LG WashTower
    DHUM_056905_WW,
    ST_B_E4H01Y_APL,
    CST_570004_WW, // LG ceiling-cassette IDU (multi-split, deviceType 401); DualCool TLV via ac_common
    FX___S, // LG front-load washer sold in Korea (deviceType 201, tunnelled 0xEC state frames)
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
            // Bridge (LG cloud mirroring) control properties are synthetic - added onto a real
            // appliance's own discovery config by addBridgeControls() below, but not one of that
            // appliance's own protocol fields, so they must never reach its setProperty().
            if (prop === BRIDGE_ENABLED_PROP || prop === BRIDGE_DEVICE_TYPE_PROP) {
                void this.handleBridgeControlSet(id, prop, value)
                return
            }
            const ha = this.haDevices.get(id)
            if (ha) ha.setProperty(prop, value)
        })

        if (this.lgBridge) {
            this.lgBridge.on('namesChanged', () => this.refreshAllNames())
            this.lgBridge.on('started', (id) => this.publishBridgeState(id))
            this.lgBridge.on('stopped', (id) => this.publishBridgeState(id))
        }
    }

    private pendingDeviceType = new Map<string, string>()

    private async handleBridgeControlSet(id: string, prop: string, value: string) {
        const lgBridge = this.lgBridge
        if (!lgBridge) return

        if (prop === BRIDGE_DEVICE_TYPE_PROP) {
            this.pendingDeviceType.set(id, value.trim())
            this.HA.publishProperty(id, BRIDGE_DEVICE_TYPE_PROP, value.trim())
            return
        }

        // prop === BRIDGE_ENABLED_PROP
        if (value === 'ON') {
            const devType = this.pendingDeviceType.get(id)
            const ok = await lgBridge.enable(id, devType || undefined)
            if (!ok) console.warn(`Could not enable the LG cloud bridge for ${id} (not logged in, or bad device type?)`)
        } else {
            lgBridge.disable(id)
        }
        this.publishBridgeState(id)
    }

    private publishBridgeState(id: string) {
        const lgBridge = this.lgBridge
        if (!lgBridge) return
        this.HA.publishProperty(id, BRIDGE_ENABLED_PROP, lgBridge.status(id) ? 'ON' : 'OFF')
    }

    /*
     * Adds the "bridge mode" switch + device-type field onto an appliance's own discovery config,
     * so they show up as two more entities on that same HA device - not a separate device. Only
     * meaningful once an LG account is linked (this.lgBridge is only ever set up from
     * rethink-cloud.ts when config.bridge is set).
     *
     * Most device classes don't have a config yet at this point - they publish it later, once real
     * status data first arrives (see e.g. tests/cloud/devices/2REB1GLVB1__2.test.ts) - and some
     * republish it again afterwards (a reconnect, a capability re-query). Rather than injecting the
     * two components once and hoping nothing overwrites config afterwards, publishConfig() itself
     * is wrapped so the components (and the LG-account name) get merged in on every publish, no
     * matter when or how many times that turns out to be.
     */
    private addBridgeControls(id: string, hadevice: HADevice, meta: Metadata) {
        const lgBridge = this.lgBridge
        if (!lgBridge) return

        const knownDeviceType = meta.deviceType ? String(meta.deviceType) : ''
        if (knownDeviceType) this.pendingDeviceType.set(id, knownDeviceType)

        const deviceTypeComp = {
            platform: 'text',
            unique_id: `$deviceid-${BRIDGE_DEVICE_TYPE_PROP}`,
            state_topic: `$this/${BRIDGE_DEVICE_TYPE_PROP}`,
            command_topic: `$this/${BRIDGE_DEVICE_TYPE_PROP}/set`,
            name: '기기타입 (bridge)',
            icon: 'mdi:identifier',
            min: 0,
            max: 5,
            entity_category: 'config',
        } as const
        const bridgeEnabledComp = {
            platform: 'switch',
            unique_id: `$deviceid-${BRIDGE_ENABLED_PROP}`,
            state_topic: `$this/${BRIDGE_ENABLED_PROP}`,
            command_topic: `$this/${BRIDGE_ENABLED_PROP}/set`,
            name: '브릿지 (LG 앱 연동)',
            icon: 'mdi:cloud-sync',
            entity_category: 'config',
        } as const

        const originalPublishConfig = hadevice.publishConfig.bind(hadevice)
        hadevice.publishConfig = () => {
            if (hadevice.config) {
                hadevice.config.components[BRIDGE_DEVICE_TYPE_PROP] = deviceTypeComp
                hadevice.config.components[BRIDGE_ENABLED_PROP] = bridgeEnabledComp
                const name = lgBridge.name(id)
                if (name) hadevice.config.device.name = name
            }
            originalPublishConfig()
            if (hadevice.config) {
                this.HA.publishProperty(id, BRIDGE_DEVICE_TYPE_PROP, this.pendingDeviceType.get(id) || '')
                this.publishBridgeState(id)
            }
        }

        if (hadevice.config) hadevice.publishConfig()
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

    newDevice(thinqdev: AnyDevice) {
        const meta = thinqdev.meta
        const oldDevice = this.haDevices.get(thinqdev.id)
        if (oldDevice) oldDevice.drop()

        let hadevice: HADevice | undefined

        if (thinqdev.platform === 'thinq1') {
            const devclass = t1deviceTypes[meta.modelId]
            if (devclass) hadevice = new devclass(this.HA, thinqdev, meta)
        } else if (thinqdev.platform === 'thinq2') {
            const devclass = t2deviceTypes[meta.modelId]
            if (devclass) hadevice = new devclass(this.HA, thinqdev, meta)
        }

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

        if (this.lgBridge) this.addBridgeControls(thinqdev.id, hadevice, meta)

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
