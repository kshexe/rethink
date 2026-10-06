import { type Metadata } from '../thinq'
import type { Connection, DeviceDiscovery } from '../homeassistant'

export default class HADevice {
    config: DeviceDiscovery | undefined

    static config(meta: Metadata, deviceInfo?: object): DeviceDiscovery {
        return {
            // The payloads are spelled out rather than left to Home Assistant's defaults, which are
            // the same two words. A discovery payload that omits them reaches the entity with the
            // key missing and setup dies on a KeyError - the defaults are not always filled in.
            availability: [
                { topic: '$this/availability', payload_available: 'online', payload_not_available: 'offline' },
                { topic: '$rethink/availability', payload_available: 'online', payload_not_available: 'offline' },
            ],
            availability_mode: 'all',
            device: {
                identifiers: '$deviceid',
                manufacturer: 'LG',
                model: meta.modelName,
                sw_version: meta.swVersion,
                ...(deviceInfo || {}),
            },
            origin: {
                name: 'rethink',
                support_url: 'https://github.com/anszom/rethink',
            },
            components: {},
        }
    }

    constructor(
        readonly HA: Connection,
        readonly id: string,
    ) {}

    setConfig(config: DeviceDiscovery) {
        this.config = config
        this.publishConfig()
    }

    drop() {
        this.cancelPendingWork()
        this.HA.publishProperty(this.id, 'availability', 'offline')
    }

    start() {}

    /*
     * Releases timers and listeners a subclass is holding, without touching HA's availability
     * state. drop() always calls this on its way to publishing offline, but it also runs on its
     * own when a device is superseded by its own replacement before its close event fires - see
     * Bridge.newDevice() - where publishing offline would only be a flicker, since the
     * replacement is about to publish online under the same id.
     */
    cancelPendingWork() {}

    // HA-side
    publishConfig() {
        if (this.config) {
            this.HA.publishProperty(this.id, 'availability', 'online')
            this.HA.publishConfig(this.id, this.config)
        }
    }

    setProperty(prop: string, mqttValue: string) {
        throw new Error('To be overriden')
    }

    // Was AABBDevice-only; TLVDevice called this.HA.publishProperty directly instead (see
    // tlv_device.ts's processKeyValue), so every values-response republished every readable field
    // unconditionally even when nothing had changed - CST_570004_WW alone, as of 2026-10-06, had
    // several fields (0x336/0x357/0x358 among them) doing exactly that on every reconnect. Lifted
    // here (2026-10-06, following anszom/rethink@e3e2e94) so every device family gets the same
    // dedup for free; callers that genuinely need to bypass it can still call
    // `this.HA.publishProperty` directly.
    publishCache = new Map<string, string | number | undefined>()

    publishProperty(prop: string, value: string | number | undefined) {
        // has() first: an undefined value on a never-published property must still go out
        if (this.publishCache.has(prop) && this.publishCache.get(prop) === value) return

        this.publishCache.set(prop, value)
        this.HA.publishProperty(this.id, prop, value)
    }
}
