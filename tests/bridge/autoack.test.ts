import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '@/bridge/index'
import { DeviceManager } from '@/cloud/devmgr'
import type { BridgeState, Credentials } from '@/bridge/state'

// Enough of the stored bridge state for Bridge's autoAck map alone - it doesn't touch credentials
// or device state at all.
function state(stored: Record<string, boolean> = {}): BridgeState {
    let saved: Record<string, boolean> = { ...stored }
    return {
        getCredentials: (): Credentials | undefined => undefined,
        setCredentials: () => {},
        getDeviceState: () => undefined,
        setDeviceState: () => {},
        getDeviceNames: () => ({}),
        setDeviceNames: () => {},
        // return a fresh object on each call, like the real JSONStorage would
        getAutoAck: () => ({ ...saved }),
        setAutoAck: (value) => {
            saved = value
        },
    }
}

describe('per-device autoAck', () => {
    test('off for a device nobody has toggled', () => {
        const bridge = new Bridge(state(), new DeviceManager())
        assert.equal(bridge.autoAck('any-device'), false)
    })

    test('a choice saved on disk is available immediately, before any toggle this run', () => {
        const bridge = new Bridge(state({ dryer: true }), new DeviceManager())
        assert.equal(bridge.autoAck('dryer'), true)
    })

    test('setAutoAck persists and announces the change', () => {
        const st = state()
        const bridge = new Bridge(st, new DeviceManager())

        let announced: [string, boolean][] = []
        bridge.on('autoAckChanged', (id, enabled) => announced.push([id, enabled]))

        bridge.setAutoAck('dryer', true)

        assert.equal(bridge.autoAck('dryer'), true)
        assert.deepEqual(st.getAutoAck(), { dryer: true })
        assert.deepEqual(announced, [['dryer', true]])
    })

    test('setting the same value again is a no-op - no write, no announcement', () => {
        const st = state({ dryer: true })
        const bridge = new Bridge(st, new DeviceManager())
        let writes = 0
        st.setAutoAck = (value) => {
            writes++
        }

        let announced = 0
        bridge.on('autoAckChanged', () => announced++)

        bridge.setAutoAck('dryer', true)

        assert.equal(writes, 0)
        assert.equal(announced, 0)
    })

    test('turning it back off persists and announces too', () => {
        const st = state({ dryer: true })
        const bridge = new Bridge(st, new DeviceManager())

        bridge.setAutoAck('dryer', false)

        assert.equal(bridge.autoAck('dryer'), false)
        assert.deepEqual(st.getAutoAck(), { dryer: false })
    })
})
