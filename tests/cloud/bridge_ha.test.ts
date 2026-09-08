import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '@/bridge/index'
import { DeviceManager } from '@/cloud/devmgr'
import type { BridgeState, Credentials } from '@/bridge/state'
import { BridgeHA } from '@/cloud/bridge_ha'
import { MockHAConnection } from '../helpers/mocks'

// Flushes every pending microtask, not just one - BridgeHA's handlers chain a few `await`s deep
// (setProperty -> handleSet -> publishLoginUrl -> beginLogin), and a single `await Promise.resolve()`
// only advances one tick.
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
}

// Same fake as tests/bridge/device-names.test.ts - enough to answer "are we logged in?".
function state(credentials?: Credentials): BridgeState {
    let creds = credentials
    return {
        getCredentials: () => (creds ? { ...creds } : undefined),
        setCredentials: (value) => {
            creds = value
        },
        getDeviceState: () => undefined,
        setDeviceState: () => {},
    }
}

describe('BridgeHA (login controls published as MQTT entities)', () => {
    test('publishes the country code, login url and logged-out state on startup', async () => {
        const bridge = new Bridge(state(), new DeviceManager())
        bridge.beginLogin = async (env) => new URL(`https://example.com/signin?country=${env.countryCode}`)

        const ha = new MockHAConnection()
        new BridgeHA(bridge, ha.asConnection())
        await flush() // the initial login-url fetch is async

        const config = ha.devices['bridge'].config!
        assert(config.components.country_code)
        assert(config.components.login_url)
        assert(config.components.login_paste)
        assert(config.components.logged_in)
        assert(config.components.logout)

        assert.equal(ha.getProperty('bridge', 'country_code', 'state'), 'KR')
        assert.equal(ha.getProperty('bridge', 'login_url', 'state'), 'https://example.com/signin?country=KR')
        assert.equal(ha.getProperty('bridge', 'logged_in', 'state'), 'OFF')
    })

    test('changing the country code re-fetches the login url for it', async () => {
        const bridge = new Bridge(state(), new DeviceManager())
        bridge.beginLogin = async (env) => new URL(`https://example.com/signin?country=${env.countryCode}`)

        const ha = new MockHAConnection()
        new BridgeHA(bridge, ha.asConnection())
        await flush()

        ha.setProperty('bridge', 'country_code', 'command', 'us')
        await flush()

        assert.equal(ha.getProperty('bridge', 'country_code', 'state'), 'US')
        assert.equal(ha.getProperty('bridge', 'login_url', 'state'), 'https://example.com/signin?country=US')
    })

    test('pasting the final url completes the login and clears the input', async () => {
        const bridge = new Bridge(state(), new DeviceManager())
        bridge.beginLogin = async () => new URL('https://example.com/signin')
        let completedWith: URL | undefined
        bridge.completeLogin = async (_env, url) => {
            completedWith = url
            return true
        }

        const ha = new MockHAConnection()
        new BridgeHA(bridge, ha.asConnection())
        await flush()

        ha.setProperty('bridge', 'login_paste', 'command', 'https://kr.m.lgaccount.com/login/iabClose?code=abc')
        await flush()

        assert.equal(completedWith?.toString(), 'https://kr.m.lgaccount.com/login/iabClose?code=abc')
        assert.equal(ha.getProperty('bridge', 'login_paste', 'state'), '')
    })

    test('logging in flips the logged_in sensor to ON', async () => {
        const bridge = new Bridge(state(), new DeviceManager())
        bridge.beginLogin = async () => new URL('https://example.com/signin')

        const ha = new MockHAConnection()
        new BridgeHA(bridge, ha.asConnection())
        await flush()

        bridge.state.setCredentials({ env: { countryCode: 'KR' }, refreshToken: 'tok' })
        bridge.emit('loggedIn')

        assert.equal(ha.getProperty('bridge', 'logged_in', 'state'), 'ON')
    })

    test('the logout button logs the bridge out', async () => {
        const bridge = new Bridge(state({ env: { countryCode: 'KR' }, refreshToken: 'tok' }), new DeviceManager())
        bridge.beginLogin = async () => new URL('https://example.com/signin')

        const ha = new MockHAConnection()
        new BridgeHA(bridge, ha.asConnection())
        await flush()

        assert(bridge.isLoggedIn())
        ha.setProperty('bridge', 'logout', 'command', '')
        await flush()

        assert.equal(bridge.isLoggedIn(), false)
    })
})
