import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import HA_bridge from '@/cloud/ha_bridge'
import { Bridge as LgCloudBridge } from '@/bridge/index'
import { DeviceManager } from '@/cloud/devmgr'
import type { BridgeState } from '@/bridge/state'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import type { Metadata } from '@/cloud/thinq'

const DEVICE_ID = 'test-id'
// An RD20_S dryer - picked only because it publishes its config synchronously from the
// constructor, with no capability/timer dance to set up first (unlike the TLV AC classes).
// The naming behavior under test is not dryer-specific.
const META: Metadata = { modelId: 'RD20_S', modelName: 'TEST', swVersion: '1.0' }
const SAMPLE_STATUS = buf('aa083000e50000bb') // RD20_S's power-write ack shape

function state(): BridgeState {
    return {
        getCredentials: () => undefined,
        setCredentials: () => {},
        getDeviceState: () => undefined,
        setDeviceState: () => {},
        getDeviceNames: () => ({}),
        setDeviceNames: () => {},
    }
}

/** Constructs a device and feeds it one status frame so it publishes its config right away. */
function makeMappedDevice(bridge: HA_bridge) {
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    bridge.newDevice(thinq)
    thinq.emit('data', SAMPLE_STATUS)
    return thinq
}

describe('HA_bridge device naming from the linked LG account', () => {
    test('without an LG bridge, the device keeps its static default name', () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, 'LG Dryer')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('the device keeps its static name when the LG account has none for it', () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, 'LG Dryer')
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
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, 'LG Dryer')

            lgBridge.deviceNames = new Map([[DEVICE_ID, '거실에어컨']])
            lgBridge.emit('namesChanged')

            assert.equal(ha.devices[DEVICE_ID].config!.device.name, '거실에어컨')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })
})
