import * as mqtt from 'mqtt'
import { Thinq2Device } from './thinqApi'
import { TypedEmitter } from 'tiny-typed-emitter'
import log from '@/util/logging'
import { note as recordNote } from '@/cloud/frame-recorder'

type ConnectionEvents = {
    ready: () => void
    data: (buffer: Buffer) => void
    // The cloud's delivery ack for an appliance frame, e.g. f0 00 <type> 04 [<seq16>] for AABB
    // devices. Unacked, an appliance retransmits each frame and may never finish its post-connect
    // sync (upstream anszom/rethink#203).
    ack: (buffer: Buffer) => void
    close: () => void
    error: (error: Error) => void
}

/**
 * What a bridged appliance tells the cloud about itself when it introduces itself.
 *
 * Three levels, in order: what the appliance is reporting right now, what it reported when it was
 * registered, and a fixed set of placeholders. The placeholders describe an HNA device rather than
 * the appliance in the room - protocolVer in particular, which decides how the cloud frames its
 * reservation polls - so they are a last resort, for a state written before either of the first two
 * was recorded.
 */
export function deployInfo(
    device: Thinq2Device,
    liveAppInfo?: Record<string, unknown>,
    livePlatformInfo?: Record<string, unknown>,
) {
    const state = device.state!
    return {
        appInfo: liveAppInfo ??
            state.deployAppInfo ?? {
                modelName: device.meta.modelName,
                modelLanguage: state.countryCode,
                softVer: '690409',
                ruleVer: '2.0.11',
                countryCode: state.countryCode,
                subCountryCode: state.countryCode,
                appVersion: 'clip_hna_v1.9.183',
                modemType: 'RTK_RTL8711am',
                regionalCode: 'eic',
                timezone: '+0100',
                svcCode: 'SVC202',
                HomeApSsid: 'whatever',
                DeviceType: '',
                ruleEngine: 'y',
                protocolVer: '1',
                oneshot: 'y',
                size: 1572864,
                fwUpgradeInfo: {
                    upgSched: {
                        cmd: 'none',
                        upgUtc: '0',
                    },
                },
            },
        platformInfo: livePlatformInfo ??
            state.deployPlatformInfo ?? {
                provisioningKey: device.meta.modelName,
                version: 'clip_v2.00.15.05-RTK_RTL8711am-SDK-8-RELEASE',
            },
    }
}

export class Connection extends TypedEmitter<ConnectionEvents> {
    mqtt: mqtt.MqttClient
    mid = 10000

    // Whether the MQTT-level CONNACK (the 'connect' event below) has ever actually landed, so a
    // later close/error note can say which side of that line this connection died on. The two are
    // different failures with different fixes: a certificate AWS IoT no longer honours is
    // rejected before 'connect' ever fires (this needs a fresh pair() - see register() in
    // bridge/index.ts), while a transport hiccup after a real CONNACK is the ordinary case the
    // existing close-triggered reconnect in bridge/index.ts already handles with the same
    // credentials. Found missing the hard way (2026-10-01): 안방에어컨's bridge connection died
    // with nothing but an ephemeral console line, which the add-on's own rolling log had long
    // since dropped by the time anyone went looking - a manual bridge disable+enable (which does
    // go through register()) fixed it, but which of the two failures that actually was is still
    // unconfirmed. This records it for the next one instead of guessing again.
    connectedOnce = false

    constructor(
        readonly device: Thinq2Device,
        // The physical device's real deploy appInfo/platformInfo (from cloud/thinq2 Device).
        // Forwarded upstream verbatim so the cloud sees the true protocolVer/softVer/etc.
        // Falls back to placeholders below when unavailable (device not yet deployed).
        readonly deployAppInfo?: Record<string, unknown>,
        readonly deployPlatformInfo?: Record<string, unknown>,
    ) {
        super()
        const state = this.device.state!
        log('bridge', `${this.device.deviceId} connecting to ${state.mqttServer}`)
        this.mqtt = mqtt.connect(state.mqttServer.replace('ssl', 'mqtts'), {
            ca: state.caCertificate,
            key: state.privateKey,
            cert: state.certificate,
            clientId: this.device.deviceId,
            reconnectPeriod: 0, // no auto-reconnect
        })

        this.mqtt.on('message', (topic, message, packet) => {
            try {
                if (topic === this.device.state!.subTopic) {
                    const payload = JSON.parse(message.toString('utf-8'))
                    if (payload.cmd === 'completeProvisioning') {
                        //msgtopic=payload.data.appInfo.publication.message
                        this.mqtt.publish(
                            this.device.state!.pubTopic,
                            JSON.stringify({
                                mid: ++this.mid,
                                did: this.device.deviceId,
                                kind: this.device.meta.modelName,
                                cmd: 'completeProvisioning_ack',
                                rssi: -48,
                                fs: 'idle',
                                data: null,
                                type: 1,
                            }),
                        )
                    } else if (payload.cmd === 'packet') {
                        log('bridge', `${this.device.deviceId} <- ${payload.data}`)
                        this.emit('data', Buffer.from(payload.data, 'hex'))
                    } else if (payload.cmd === 'ack' && typeof payload.data === 'string') {
                        // The cloud's delivery ack for an appliance frame, e.g. f0 00 <type> 04
                        // [<seq16>] for AABB devices. Unacked, an appliance retransmits each frame
                        // and may never finish its post-connect sync (upstream anszom/rethink#203).
                        log('bridge', `${this.device.deviceId} <- ack ${payload.data}`)
                        this.emit('ack', Buffer.from(payload.data, 'hex'))
                    } else {
                        // not forwarded; logged in full to identify it from a capture
                        log('bridge', `${this.device.deviceId} <- dropped ${payload.cmd}: ${message.toString('utf-8')}`)
                    }
                }
            } catch (err) {
                console.log(err)
            }
        })

        this.mqtt.on('connect', async () => {
            log('bridge', `${this.device.deviceId} connected`)
            this.connectedOnce = true
            this.emit('ready')

            // subscribe/publish can reject (e.g. the connection drops mid-handshake) - an
            // unhandled rejection in an event listener is fatal by default since Node 15, which
            // would crash the whole process over what's just this one bridged device's hiccup.
            try {
                await this.mqtt.subscribe(this.device.state!.subTopic)
                await this.mqtt.publish(
                    this.device.state!.provTopic,
                    JSON.stringify({
                        mid: ++this.mid,
                        did: this.device.deviceId,
                        kind: this.device.meta.modelName,
                        cmd: 'preDeploy',
                        rssi: -48,
                        fs: 'idle',
                        data: deployInfo(this.device, this.deployAppInfo, this.deployPlatformInfo),
                        type: 0,
                    }),
                    { qos: 1 },
                )
            } catch (err) {
                log('bridge', `${this.device.deviceId} preDeploy failed: ${err}`)
                recordNote(this.device.deviceId, this.device.meta, 'bridge-connection-failed', {
                    stage: 'preDeploy',
                    message: String(err),
                })
                this.emit('error', err instanceof Error ? err : new Error(String(err)))
            }
        })

        this.mqtt.on('close', () => {
            recordNote(this.device.deviceId, this.device.meta, 'bridge-connection-closed', {
                connectedOnce: this.connectedOnce,
            })
            this.emit('close')
        })
        this.mqtt.on('error', (err) => {
            log('bridge', `Error communicating with ${state.mqttServer}: ${err}`)
            recordNote(this.device.deviceId, this.device.meta, 'bridge-connection-failed', {
                stage: this.connectedOnce ? 'post-connect' : 'connect',
                message: String(err),
            })
            this.emit('error', err)
        })
    }

    send(data: string | Buffer) {
        if (Buffer.isBuffer(data)) data = data.toString('hex').toUpperCase()

        log('bridge', `${this.device.deviceId} -> ${data}`)
        this.mqtt.publish(
            this.device.state!.pubTopic,
            JSON.stringify({
                mid: ++this.mid,
                did: this.device.deviceId,
                kind: this.device.meta.modelName,
                cmd: 'device_packet',
                rssi: -48,
                fs: 'idle',
                data,
                type: 1,
            }),
        )
    }

    destroy() {
        this.mqtt.end()
    }
}
