import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { request, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { advertisedHost, routes } from '@/cloud/thinq2/provisioning'
import { normalize, RawConfig } from '@/util/config'
import { CA } from '@/util/ca'
import { createCertificateRequest } from '@/util/pki'

const HOSTNAME = 'rethink.lan'
// The name a Korean unit asks for when it was never set up against us and only arrives redirected.
const LG_HOST = 'common.iot.kic.lgthinq.com'

function makeConfig(overrides: Partial<RawConfig> = {}) {
    return normalize({
        hostname: HOSTNAME,
        homeassistant: {
            mqtt_url: 'mqtt://127.0.0.1:1883',
            discovery_prefix: 'homeassistant',
            rethink_prefix: 'rethink',
            mqtt_user: '',
            mqtt_pass: '',
        },
        ca_key_file: 'ca.key',
        ca_cert_file: 'ca.cert',
        https_port: 443,
        mqtts_port: 8883,
        mqtt_port: 1884,
        ...overrides,
    })
}

describe('advertisedHost', () => {
    test('advertises config.hostname by default', () => {
        assert.equal(advertisedHost(makeConfig(), LG_HOST), HOSTNAME)
    })

    test('echoes the requested name when the option is on', () => {
        assert.equal(advertisedHost(makeConfig({ advertise_requested_host: true }), LG_HOST), LG_HOST)
    })

    test('falls back to config.hostname when there is no Host header', () => {
        assert.equal(advertisedHost(makeConfig({ advertise_requested_host: true }), undefined), HOSTNAME)
    })

    test('refuses an address - the appliance would store it and be pinned to one machine', () => {
        assert.equal(advertisedHost(makeConfig({ advertise_requested_host: true }), '192.168.1.7'), HOSTNAME)
    })

    test('refuses anything that is not a hostname', () => {
        assert.equal(advertisedHost(makeConfig({ advertise_requested_host: true }), 'not a hostname'), HOSTNAME)
    })
})

describe('GET /route', () => {
    let ca: CA

    before(async () => {
        ca = await CA.create()
    })

    // A fresh app/server per call, not one shared across the describe block: routes() closes
    // over the `config` it is given at construction time, a plain function parameter, not a
    // live reference to whatever the caller's own variable holds later - so a server built once
    // in a shared before() would only ever see the config from that first build.
    async function route(config: ReturnType<typeof makeConfig>, host: string) {
        const app = express()
        app.use(routes(config, ca))
        const server = app.listen(0, '127.0.0.1')
        try {
            await new Promise((resolve) => server.once('listening', resolve))
            const port = (server.address() as AddressInfo).port

            const body = await new Promise<string>((resolve, reject) => {
                const req = request(
                    { host: '127.0.0.1', port, path: '/route', method: 'GET', headers: { Host: host } },
                    (res) => {
                        const chunks: Buffer[] = []
                        res.on('data', (c: Buffer) => chunks.push(c))
                        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
                    },
                )
                req.on('error', reject)
                req.end()
            })
            return JSON.parse(body) as { result: { apiServer: string; mqttServer: string } }
        } finally {
            await new Promise((resolve) => server.close(resolve))
        }
    }

    test('points the appliance at config.hostname by default', async () => {
        const { result } = await route(makeConfig(), LG_HOST)

        assert.equal(result.apiServer, `https://${HOSTNAME}:443`)
        assert.equal(result.mqttServer, `ssl://${HOSTNAME}:8883`)
    })

    test('leaves a redirected appliance on the name it already uses', async () => {
        const { result } = await route(makeConfig({ advertise_requested_host: true }), LG_HOST)

        assert.equal(result.apiServer, `https://${LG_HOST}:443`)
        assert.equal(result.mqttServer, `ssl://${LG_HOST}:8883`)
    })

    test('keeps advertising the bind-vs-advertise port split', async () => {
        const config = makeConfig({
            advertise_requested_host: true,
            https_port: { bind: 4433, advertise: 443 },
            mqtts_port: { bind: 8884, advertise: 8883 },
        })
        const { result } = await route(config, LG_HOST)

        assert.equal(result.apiServer, `https://${LG_HOST}:443`)
        assert.equal(result.mqttServer, `ssl://${LG_HOST}:8883`)
    })
})

describe('POST /device/:deviceId/certificate', () => {
    let server: Server
    let port: number
    let ca: CA

    before(async () => {
        ca = await CA.create()

        const config = makeConfig()
        const app = express()
        app.use(express.json())
        app.use(routes(config, ca))
        server = app.listen(0, '127.0.0.1')
        await new Promise((resolve) => server.once('listening', resolve))
        port = (server.address() as AddressInfo).port
    })

    after(async () => {
        await new Promise((resolve) => server.close(resolve))
    })

    async function sign(body: unknown) {
        const payload = JSON.stringify(body)
        const raw = await new Promise<string>((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port,
                    path: '/device/aaaabbbb-cccc-dddd-eeee-ffff00001111/certificate',
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
                },
                (res) => {
                    const chunks: Buffer[] = []
                    res.on('data', (c: Buffer) => chunks.push(c))
                    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
                },
            )
            req.on('error', reject)
            req.end(payload)
        })
        return JSON.parse(raw) as { resultCode: string; result?: { certificatePem: string } }
    }

    test('signs an appliance CSR with the CA the appliance pinned', async () => {
        const { csr } = await createCertificateRequest('CN=*.clip.com, O=LGE, C=KR', 'ec-p256')
        const response = await sign({ csr })

        assert.equal(response.resultCode, '0000')
        const cert = new X509Certificate(response.result!.certificatePem)
        assert.equal(cert.verify(ca.certificate.publicKey), true)
    })

    // The failure this guards against: answering with resultCode 0000 and an empty certificatePem,
    // which the appliance can only report as some later, unrelated problem.
    test('refuses a request with no CSR instead of reporting success', async () => {
        const response = await sign({})

        assert.notEqual(response.resultCode, '0000')
        assert.equal(response.result?.certificatePem, undefined)
    })

    test('refuses a CSR the signer cannot read', async () => {
        const response = await sign({ csr: '-----BEGIN CERTIFICATE REQUEST-----\nnot base64\n' })

        assert.notEqual(response.resultCode, '0000')
        assert.equal(response.result?.certificatePem, undefined)
    })
})
