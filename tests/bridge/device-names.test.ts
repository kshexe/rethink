import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '@/bridge/index'
import { DeviceManager } from '@/cloud/devmgr'
import type { BridgeState, Credentials } from '@/bridge/state'

// Enough of the stored bridge state to answer "are we logged in?", which is the only question
// refreshNames() asks before deciding whether there is an account to read names from.
function state(credentials?: Credentials, storedNames: Record<string, string> = {}): BridgeState {
    let creds = credentials
    let names: Record<string, string> = { ...storedNames }
    return {
        // return a fresh object on each call
        getCredentials: () => (creds ? { ...creds } : undefined),
        setCredentials: (value) => {
            creds = value
        },
        getDeviceState: () => undefined,
        setDeviceState: () => {},
        getDeviceNames: () => ({ ...names }),
        setDeviceNames: (value) => {
            names = value
        },
    }
}

describe('ThinQ device names', () => {
    test('there are none until an account has been read', () => {
        const bridge = new Bridge(state(), new DeviceManager())
        assert.equal(bridge.name('any-device'), undefined)
    })

    test('names cached on disk are available immediately, before any cloud read', () => {
        const bridge = new Bridge(state(undefined, { cassette: '거실에어컨' }), new DeviceManager())
        assert.equal(bridge.name('cassette'), '거실에어컨')
    })

    test('logging out also wipes the on-disk cache', async () => {
        const st = state()
        const bridge = new Bridge(st, new DeviceManager())
        bridge.deviceNames = new Map([['cassette', '거실에어컨']])

        bridge.logout()
        await Promise.resolve()

        assert.deepEqual(st.getDeviceNames(), {})
    })

    test('logging out clears them, and says so', async () => {
        // Built logged out so the constructor's own refresh does not go looking for a cloud; the names
        // are then put in place as a successful read would have left them.
        const bridge = new Bridge(state(), new DeviceManager())
        bridge.deviceNames = new Map([['cassette', 'Bedroom AC']])

        let announced = 0
        bridge.on('namesChanged', () => announced++)

        bridge.logout()
        await Promise.resolve() // logout does not wait for the refresh it kicks off

        assert.equal(bridge.name('cassette'), undefined)
        assert.equal(announced, 1)
    })
})
