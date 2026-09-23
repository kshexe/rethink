export type RawConfig = {
    hostname: string
    advertise_requested_host?: boolean
    homeassistant: HAConfig
    ca_key_file: string
    ca_cert_file: string
    https_port: Port | number
    mqtts_port: Port | number
    mqtt_port: Port | number
    management_port?: Port | number
    mqtt?: boolean
    bridge?: {
        storage_path: string
    }
    log?: string[]
    /** Raw-frame recorder: keep this many days of per-day JSONL under frame_log_dir. 0 = off. */
    frame_log_days?: number
    frame_log_dir?: string
}

export type Config = {
    hostname: string
    advertise_requested_host: boolean
    homeassistant: HAConfig
    ca_key_file: string
    ca_cert_file: string
    https_port: Port
    mqtts_port: Port
    mqtt_port: Port
    management_port?: Port
    mqtt: boolean
    bridge?: {
        storage_path: string
    }
    log: string[]
    frame_log_days: number
    frame_log_dir: string
}

export type HAConfig = {
    mqtt_url: string
    discovery_prefix: string
    rethink_prefix: string
    mqtt_user: string
    mqtt_pass: string
    /**
     * Which language a device profile publishes appliance-specific NAMES in - "en" (the default) or
     * "ko". FX___S publishes its course names either way; a profile that only knows one set ignores
     * this. It is not a translation layer: Home Assistant cannot translate the STATE of an entity
     * created by MQTT discovery, because that needs translation_key plus the owning integration's
     * strings.json and the owner is `mqtt`. Entity states are what automations compare against, so
     * changing this renames things they match on - profiles keep accepting every language they know
     * on the command side, since a write is unambiguous.
     */
    language?: string
}

export type CA = {
    key: string
    cert: string
}

export type Port = {
    bind: number
    advertise: number
    address?: string
}

function parsePort(port: Port | number): Port
function parsePort(port: Port | number | undefined): Port | undefined
function parsePort(port: Port | number | undefined): Port | undefined {
    return typeof port === 'number' ? { bind: port, advertise: port } : port
}

export function normalize(config: RawConfig): Config {
    return {
        log: ['status', 'incoming', 'HTTPS'],
        mqtt: true,
        ...config,
        frame_log_days: config.frame_log_days ?? 0,
        frame_log_dir: config.frame_log_dir ?? '/share/rethink/frames',
        advertise_requested_host: config.advertise_requested_host ?? false,
        https_port: parsePort(config.https_port),
        mqtts_port: parsePort(config.mqtts_port),
        mqtt_port: parsePort(config.mqtt_port),
        management_port: parsePort(config.management_port),
    }
}
