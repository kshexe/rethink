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
async function makeMappedDevice(bridge: HA_bridge) {
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    await bridge.newDevice(thinq)
    thinq.emit('data', SAMPLE_STATUS)
    return thinq
}

describe('HA_bridge device naming from the linked LG account', () => {
    test('without an LG bridge, the device keeps its static default name', async () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        await makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, 'LG Dryer')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('the device keeps its static name when the LG account has none for it', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        const bridge = new HA_bridge(ha.asConnection(), lgBridge, 10)
        await makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, 'LG Dryer')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('the device is renamed from the LG account once its alias is known', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        lgBridge.deviceNames = new Map([[DEVICE_ID, '거실에어컨']])
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        await makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, '거실에어컨')
            // suggested_area groups the device's entities into an Area named after the room -
            // "거실" here, the account name minus its "에어컨" suffix - see ha_bridge.ts's
            // roomFromDeviceName(). The device's own name is untouched.
            assert.equal(ha.devices[DEVICE_ID].config!.device.suggested_area, '거실')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a namesChanged event renames an already-mapped device', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        const bridge = new HA_bridge(ha.asConnection(), lgBridge, 10)
        await makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, 'LG Dryer')
            assert.equal(ha.devices[DEVICE_ID].config!.device.suggested_area, undefined)

            lgBridge.deviceNames = new Map([[DEVICE_ID, '거실에어컨']])
            lgBridge.emit('namesChanged')

            assert.equal(ha.devices[DEVICE_ID].config!.device.name, '거실에어컨')
            assert.equal(ha.devices[DEVICE_ID].config!.device.suggested_area, '거실')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('roomFromDeviceName: an appliance with no room prefix (one per household, not per-room) gets no suggested_area', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        lgBridge.deviceNames = new Map([[DEVICE_ID, '냉장고']])
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        await makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, '냉장고')
            // "냉장고" *is* the appliance-type suffix, with nothing in front of it to be a room -
            // matches this household's actual naming (there's only one fridge, never "거실냉장고").
            assert.equal(ha.devices[DEVICE_ID].config!.device.suggested_area, undefined)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('roomFromDeviceName: 김치냉장고 is checked before 냉장고, so its room prefix (empty here) is not swallowed into "김치"', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        lgBridge.deviceNames = new Map([[DEVICE_ID, '김치냉장고']])
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        await makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.suggested_area, undefined)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('roomFromDeviceName: a name matching no known appliance-type suffix gets no suggested_area', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        lgBridge.deviceNames = new Map([[DEVICE_ID, '내방청소기']])
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        await makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, '내방청소기')
            assert.equal(ha.devices[DEVICE_ID].config!.device.suggested_area, undefined)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a brand-new device waits for a slow-but-successful name lookup, so its very first publish already carries the real name - not just a fast-follow correction', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        // No cached name yet (fresh device) - simulate the account answering slowly but within
        // the timeout, the same way the real refreshNames() would populate deviceNames.
        lgBridge.refreshNames = () => {
            lgBridge.deviceNames = new Map([[DEVICE_ID, '냉장고']])
            return new Promise((resolve) => setTimeout(resolve, 10))
        }
        const bridge = new HA_bridge(ha.asConnection(), lgBridge, 5000)
        try {
            await makeMappedDevice(bridge)
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, '냉장고')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a name lookup that never answers does not block the device forever - it falls back to the static name after the bounded wait', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        lgBridge.refreshNames = () => new Promise(() => {}) // never resolves
        const bridge = new HA_bridge(ha.asConnection(), lgBridge, 10)
        try {
            await makeMappedDevice(bridge)
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, 'LG Dryer')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('an already-known device (the common case - cached from disk) is not delayed at all', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        lgBridge.deviceNames = new Map([[DEVICE_ID, '거실에어컨']])
        // A refreshNames() call here would mean the wait wasn't actually skipped - fail loudly.
        lgBridge.refreshNames = () => {
            throw new Error('refreshNames() should not be called when the name is already known')
        }
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        try {
            await makeMappedDevice(bridge)
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, '거실에어컨')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })
})
