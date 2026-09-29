import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import HA_bridge from '@/cloud/ha_bridge'
import { Bridge as LgCloudBridge } from '@/bridge/index'
import { DeviceManager } from '@/cloud/devmgr'
import type { BridgeState } from '@/bridge/state'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import type { Metadata } from '@/cloud/thinq'
import AABBDevice from '@/cloud/devices/aabb_device'

const DEVICE_ID = 'test-id'
// An RD20_S dryer - picked only because it publishes its config synchronously from the
// constructor, with no capability/timer dance to set up first (unlike the TLV AC classes).
// The naming behavior under test is not dryer-specific.
const META: Metadata = { modelId: 'RD20_S', modelName: 'TEST', swVersion: '1.0' }
const SAMPLE_STATUS = buf('aa083000e50000bb') // RD20_S's power-write ack shape

class AvailabilityRecordingHA extends MockHAConnection {
    availabilityHistory: string[] = []

    override publishProperty(id: string, property: string, value: string | number | undefined) {
        super.publishProperty(id, property, value)
        if (property === 'availability') this.availabilityHistory.push(String(value))
    }
}

function state(): BridgeState {
    return {
        getCredentials: () => undefined,
        setCredentials: () => {},
        getDeviceState: () => undefined,
        setDeviceState: () => {},
        getDeviceNames: () => ({}),
        setDeviceNames: () => {},
        getAutoAck: () => ({}),
        setAutoAck: () => {},
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
    // No static per-model fallback (e.g. "LG Dryer") is baked in any more - device handlers no
    // longer pass a name to HADevice.config() at all. HA falls back to manufacturer+model for
    // display when device.name is absent, and - since nothing here ever computes entity_id from
    // it either, see the file header's entity-naming saga - there's no naming downside, just one
    // less thing that could ever get baked into an entity_id before the real name arrives.
    test('without an LG bridge, the device has no name (falls back to manufacturer+model in HA)', async () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        await makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, undefined)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('the device has no name when the LG account has none for it either', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        const bridge = new HA_bridge(ha.asConnection(), lgBridge, 10)
        await makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, undefined)
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
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, undefined)

            lgBridge.deviceNames = new Map([[DEVICE_ID, '거실에어컨']])
            lgBridge.emit('namesChanged')

            assert.equal(ha.devices[DEVICE_ID].config!.device.name, '거실에어컨')
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

    test('a name lookup that never answers does not block the device forever - it publishes with no name after the bounded wait', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        lgBridge.refreshNames = () => new Promise(() => {}) // never resolves
        const bridge = new HA_bridge(ha.asConnection(), lgBridge, 10)
        try {
            await makeMappedDevice(bridge)
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, undefined)
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

describe('HA_bridge applies the panel-chosen autoAck setting', () => {
    test('a device with no saved choice starts with autoAck off, same as its own hardcoded default', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        await makeMappedDevice(bridge)
        try {
            const handler = bridge.haDevices.get(DEVICE_ID)
            assert.ok(handler instanceof AABBDevice)
            assert.equal(handler.autoAck, false)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a device already opted in picks that back up on (re)connect', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        lgBridge.setAutoAck(DEVICE_ID, true)
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        await makeMappedDevice(bridge)
        try {
            const handler = bridge.haDevices.get(DEVICE_ID)
            assert.ok(handler instanceof AABBDevice)
            assert.equal(handler.autoAck, true)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('toggling it from the panel flips the live handler with no reconnect', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        await makeMappedDevice(bridge)
        try {
            const handler = bridge.haDevices.get(DEVICE_ID)
            assert.ok(handler instanceof AABBDevice)
            assert.equal(handler.autoAck, false)

            lgBridge.setAutoAck(DEVICE_ID, true)
            assert.equal(handler.autoAck, true, 'the same live instance, not a new one')

            lgBridge.setAutoAck(DEVICE_ID, false)
            assert.equal(handler.autoAck, false)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })
})

describe('HA_bridge avoids an availability flicker across a reconnect', () => {
    const GRACE_MS = 20

    test('a replacement that connects before the old close event fires never goes offline', async () => {
        const ha = new AvailabilityRecordingHA()
        const bridge = new HA_bridge(ha.asConnection(), undefined, 5000, GRACE_MS)

        const oldConnection = new MockThinq2Device(DEVICE_ID, META)
        await makeMappedDevice2(bridge, oldConnection)
        ha.availabilityHistory = []

        const newConnection = new MockThinq2Device(DEVICE_ID, META)
        await makeMappedDevice2(bridge, newConnection)
        assert.deepEqual(ha.availabilityHistory, ['online'])

        // The superseded connection's close, arriving late, must not touch the replacement.
        oldConnection.emit('close')
        assert.deepEqual(ha.availabilityHistory, ['online'])

        try {
            // A genuine close of the now-active connection still goes offline, once the grace
            // period passes with nothing reconnecting.
            newConnection.emit('close')
            await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 2))
            assert.deepEqual(ha.availabilityHistory, ['online', 'offline'])
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a replacement that connects shortly after the old one closed suppresses the blip', async () => {
        const ha = new AvailabilityRecordingHA()
        const bridge = new HA_bridge(ha.asConnection(), undefined, 5000, GRACE_MS)

        const oldConnection = new MockThinq2Device(DEVICE_ID, META)
        await makeMappedDevice2(bridge, oldConnection)
        ha.availabilityHistory = []

        oldConnection.emit('close')
        await new Promise((resolve) => setTimeout(resolve, GRACE_MS / 4)) // well inside the grace window

        const newConnection = new MockThinq2Device(DEVICE_ID, META)
        try {
            await makeMappedDevice2(bridge, newConnection)
            await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 2))
            assert.deepEqual(ha.availabilityHistory, ['online'])
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a disconnect nothing reconnects to still goes offline, just after the grace period', async () => {
        const ha = new AvailabilityRecordingHA()
        const bridge = new HA_bridge(ha.asConnection(), undefined, 5000, GRACE_MS)

        const connection = new MockThinq2Device(DEVICE_ID, META)
        await makeMappedDevice2(bridge, connection)
        ha.availabilityHistory = []

        connection.emit('close')
        assert.deepEqual(ha.availabilityHistory, [], 'not yet - still inside the grace period')

        await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 2))
        assert.deepEqual(ha.availabilityHistory, ['offline'])
    })
})

/** Like makeMappedDevice, but for a caller supplying its own MockThinq2Device instance. */
async function makeMappedDevice2(bridge: HA_bridge, thinq: MockThinq2Device) {
    await bridge.newDevice(thinq)
    thinq.emit('data', SAMPLE_STATUS)
    return thinq
}
