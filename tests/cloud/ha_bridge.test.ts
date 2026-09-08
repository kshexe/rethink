import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import HA_bridge from '@/cloud/ha_bridge'
import { Bridge as LgCloudBridge } from '@/bridge/index'
import { DeviceManager } from '@/cloud/devmgr'
import type { BridgeState, Credentials } from '@/bridge/state'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import type { Metadata } from '@/cloud/thinq'

const DEVICE_ID = 'test-id'
// A 2REB1GLVB1__2 fridge - picked only because it publishes its config synchronously off a
// single status frame, with no capability/timer dance to set up first (unlike the TLV AC
// classes). Bridge controls are not fridge-specific.
const META: Metadata = { modelId: '2REB1GLVB1__2', modelName: 'TEST', swVersion: '1.0' }
const SAMPLE_STATUS = buf('AA1710EB020504010000000201000100000000000099BB')

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

function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
}

/** Constructs a device and feeds it one status frame so it publishes its config right away. */
function makeMappedDevice(bridge: HA_bridge) {
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    bridge.newDevice(thinq)
    thinq.emit('data', SAMPLE_STATUS)
    return thinq
}

describe('HA_bridge bridge (LG cloud) controls', () => {
    test('without an LG bridge, a device gets no bridge_enabled/bridge_device_type components', () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        makeMappedDevice(bridge)
        try {
            const config = ha.devices[DEVICE_ID].config!
            assert.equal(config.components.bridge_enabled, undefined)
            assert.equal(config.components.bridge_device_type, undefined)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('with an LG bridge, the same device gets both components alongside its own', () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        makeMappedDevice(bridge)
        try {
            const config = ha.devices[DEVICE_ID].config!
            assert(config.components.bridge_enabled)
            assert(config.components.bridge_device_type)
            // The device's own entities are still there too.
            assert(config.components.fridge_setpoint)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('the device keeps its own name when the LG account has none for it', () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, 'LG Fridge')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('the device is renamed from the LG account once its alias is known', () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        lgBridge.deviceNames = new Map([[DEVICE_ID, '거실에어컨']])
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, '거실에어컨')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a namesChanged event renames an already-mapped device', () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, 'LG Fridge')

            lgBridge.deviceNames = new Map([[DEVICE_ID, '거실에어컨']])
            lgBridge.emit('namesChanged')

            assert.equal(ha.devices[DEVICE_ID].config!.device.name, '거실에어컨')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('setting bridge_device_type publishes it back but never reaches the appliance itself', () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        makeMappedDevice(bridge)

        const hadevice = bridge.haDevices.get(DEVICE_ID)!
        try {
            const forwardedProps: string[] = []
            const realSetProperty = hadevice.setProperty.bind(hadevice)
            hadevice.setProperty = (prop, value) => {
                forwardedProps.push(prop)
                realSetProperty(prop, value)
            }

            ha.setProperty(DEVICE_ID, 'bridge_device_type', 'command', '401')

            assert.equal(ha.getProperty(DEVICE_ID, 'bridge_device_type', 'state'), '401')
            assert.deepEqual(forwardedProps, [])
        } finally {
            hadevice.drop()
        }
    })

    test('turning bridge_enabled ON calls enable() with the last device type set, and publishes the result', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(
            state({ env: { countryCode: 'KR' }, refreshToken: 'tok' }),
            new DeviceManager(),
        )
        let enabledWith: [string, string | undefined] | undefined
        lgBridge.enable = async (id, devType) => {
            enabledWith = [id, devType]
            return true
        }
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        makeMappedDevice(bridge)
        try {
            ha.setProperty(DEVICE_ID, 'bridge_device_type', 'command', '401')
            ha.setProperty(DEVICE_ID, 'bridge_enabled', 'command', 'ON')
            await flush()

            assert.deepEqual(enabledWith, [DEVICE_ID, '401'])
            // status() is still false here: enable() was stubbed above, so bridgedDevices was
            // never actually populated - this only checks that we published *some* result.
            assert.equal(ha.getProperty(DEVICE_ID, 'bridge_enabled', 'state'), 'OFF')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('turning bridge_enabled OFF calls disable()', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(
            state({ env: { countryCode: 'KR' }, refreshToken: 'tok' }),
            new DeviceManager(),
        )
        let disabledId: string | undefined
        lgBridge.disable = (id) => {
            disabledId = id
        }
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        makeMappedDevice(bridge)
        try {
            ha.setProperty(DEVICE_ID, 'bridge_enabled', 'command', 'OFF')
            await flush()

            assert.equal(disabledId, DEVICE_ID)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })
})
