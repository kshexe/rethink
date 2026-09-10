import express from 'express'
import stripJsonComments from 'strip-json-comments'
import { mkdirSync, readFileSync } from 'node:fs'
import * as https from 'node:https'
import { dirname, resolve } from 'node:path'
import { Broker } from './cloud/mqtt-broker'
import * as tls from 'node:tls'
import * as net from 'node:net'
import { routes as thinq2Routes } from './cloud/thinq2/provisioning'
import { DeviceAcceptor as T2Acceptor } from './cloud/thinq2/device'
import { Connection as HA_connection } from './cloud/homeassistant'
import HA_bridge from './cloud/ha_bridge'
import { normalize as normalizeConfig, RawConfig, CA } from './util/config'
import { createCa } from './util/pki'
import { CertificateIssuer } from './util/sni'
import * as Management from './management'

import log, { setFilter as setLogFilter } from './util/logging'
import { DeviceManager } from './cloud/devmgr'
import { Bridge } from './bridge'
import { JSONStorage } from './bridge/state'
import { JSONControlState } from './cloud/control_state'
import { configure as configureFrameRecorder } from './cloud/frame-recorder'

const configPath = resolve(process.argv[2] ?? './config.json')
const configDir = dirname(configPath)
const config = normalizeConfig(JSON.parse(stripJsonComments(readFileSync(configPath).toString('utf-8'))) as RawConfig)

config.ca_key_file = resolve(configDir, config.ca_key_file)
config.ca_cert_file = resolve(configDir, config.ca_cert_file)
if (config.bridge) config.bridge.storage_path = resolve(configDir, config.bridge.storage_path)

if (!config.log) config.log = ['status', 'incoming', 'HTTPS']

const enabled = Object.fromEntries(config.log.map((key) => [key, true]))
setLogFilter((topic) => {
    return enabled[topic] || enabled['all']
})

configureFrameRecorder({ dir: config.frame_log_dir, days: config.frame_log_days })

const caFiles = { certFile: config.ca_cert_file, keyFile: config.ca_key_file }

// The CA is the trust anchor an appliance pins when it fetches /route/certificate. It is no longer
// served as a server certificate - every name we answer to gets its own leaf below - so its subject
// does not have to match anything, and it is created once and then left alone. Only "there is no CA
// yet" leads to making one: overwriting a CA that appliances have already pinned would leave every
// one of them unable to connect until it is provisioned again, which is not a thing to do because a
// file could not be read.
function loadOrCreateCert(): CA {
    try {
        return {
            key: readFileSync(config.ca_key_file).toString('utf-8'),
            cert: readFileSync(config.ca_cert_file).toString('utf-8'),
        }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    log('status', 'Creating a new key/certificate for the CA')
    createCa(config.hostname, caFiles)

    return {
        key: readFileSync(config.ca_key_file).toString('utf-8'),
        cert: readFileSync(config.ca_cert_file).toString('utf-8'),
    }
}

const ca = loadOrCreateCert()

// Appliances that reach us by redirection rather than by setup still ask for an LG hostname, which
// varies between units of the same model. Serve each requested name its own certificate, signed by
// the CA they already trust.
const issuer = new CertificateIssuer(caFiles, config.hostname)

// The default certificate - what a connection that sends no SNI at all gets, an appliance reaching
// us by address among them - is a leaf for config.hostname rather than the CA itself, so that it
// carries a subjectAltName. The CA has only a subject, which clients are free to stop honouring.
const tlsOptions = { ...issuer.issue(config.hostname), SNICallback: issuer.SNICallback }

// Thinq2
function t2setup(manager: DeviceManager) {
    // Thinq2 HTTPS server
    const app = express()
    app.use(express.json())

    app.use(function (req, res, next) {
        log('HTTPS', req.hostname, req.url)
        next()
    })

    // `ca`, not `tlsOptions`: these routes hand out the CA itself and sign appliance certificates
    // with it. An appliance pins what it gets here, so it has to be the CA, never a per-name leaf.
    app.use(thinq2Routes(config, ca))

    // fallback
    app.use((req, res) => {
        res.header('content-type', 'text/xml;charset=utf-8')
        res.end('')
    })

    https.createServer(tlsOptions, app).listen(config.https_port.bind, config.https_port.address)

    // internal MQTT broker
    const broker = new Broker()

    if (config.mqtt) {
        tls.createServer(tlsOptions, broker.accept.bind(broker)).listen(
            config.mqtts_port.bind,
            config.mqtts_port.address,
        )
        net.createServer({}, broker.accept.bind(broker)).listen(config.mqtt_port.bind, config.mqtt_port.address)
    }

    const acceptor = new T2Acceptor(broker)
    acceptor.on('newDevice', manager.accept.bind(manager))
}

// HA connector
const manager = new DeviceManager()

let bridge: Bridge | undefined
if (config.bridge) {
    mkdirSync(config.bridge.storage_path, { recursive: true })
    const storage = new JSONStorage(config.bridge.storage_path)
    bridge = new Bridge(storage, manager)
    // Refresh the ThinQ-account names once at startup regardless of whether the management panel
    // is open. The panel's own 15-min timer only runs while a browser is connected, so without
    // this a device added or renamed since the last panel session would keep a stale name (or,
    // for a brand-new appliance, the model-name fallback) indefinitely.
    void bridge.refreshNames()
}

mkdirSync(dirname(config.control_state_file), { recursive: true })
const controlState = new JSONControlState(config.control_state_file)

const ha = new HA_bridge(new HA_connection(config.homeassistant), bridge, controlState)
manager.on('newDevice', (dev) => ha.newDevice(dev))

t2setup(manager)

if (config.management_port)
    Management.app(ha, manager, bridge).listen(config.management_port.bind, config.management_port.address)

console.log('Rethink cloud ready')
