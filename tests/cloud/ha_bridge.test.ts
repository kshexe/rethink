import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import HA_bridge from '@/cloud/ha_bridge'
import type AABBDevice from '@/cloud/devices/aabb_device'
import { Bridge as LgCloudBridge } from '@/bridge/index'
import { DeviceManager } from '@/cloud/devmgr'
import type { BridgeState } from '@/bridge/state'
import type { ControlState } from '@/cloud/control_state'
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

/** In-memory stand-in for JSONControlState, so persistence can be asserted without touching disk. */
function mockControlState(initial: string[] = []): ControlState {
    let disabled = initial
    return {
        getDisabledDevices: () => disabled,
        setDisabledDevices: (ids) => {
            disabled = ids
        },
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

describe('HA_bridge control enable/disable', () => {
    test('is enabled by default: a command from HA reaches the appliance', () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        const thinq = makeMappedDevice(bridge)
        try {
            assert.equal(bridge.isControlEnabled(DEVICE_ID), true)
            ha.setProperty(DEVICE_ID, 'power', 'command', 'ON')
            assert.equal(thinq.outbox.length, 1)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('disabling control removes the switch component from the published config, leaving the sensor', () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        makeMappedDevice(bridge)
        try {
            assert.ok(ha.devices[DEVICE_ID].config!.components.power, 'switch present while enabled')

            bridge.setControlEnabled(DEVICE_ID, false)

            assert.equal(
                ha.devices[DEVICE_ID].config!.components.power,
                undefined,
                'switch (has a command_topic) removed',
            )
            assert.ok(ha.devices[DEVICE_ID].config!.components.remaining_minutes, 'sensor (no command_topic) untouched')

            // re-enabling brings it straight back
            bridge.setControlEnabled(DEVICE_ID, true)
            assert.ok(ha.devices[DEVICE_ID].config!.components.power, 'switch restored')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a command still cannot reach the appliance while disabled, and works again once re-enabled', () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        const thinq = makeMappedDevice(bridge)
        try {
            bridge.setControlEnabled(DEVICE_ID, false)

            // The switch component is gone, so a real HA client has no command_topic to publish to
            // any more - simulate a stale client (or a race right at the toggle) that still has
            // one cached, to prove the setProperty-level gate also holds as a second layer.
            ha.emit('setProperty', DEVICE_ID, 'power', 'ON')
            assert.equal(thinq.outbox.length, 0, 'no command should have reached the appliance')
            assert.equal(ha.devices[DEVICE_ID].properties.power, undefined, 'no optimistic state published either')

            bridge.setControlEnabled(DEVICE_ID, true)
            ha.setProperty(DEVICE_ID, 'power', 'command', 'ON')
            assert.equal(thinq.outbox.length, 1)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a disabled device with a linked LG account still gets its real name on the filtered config (name and control-filter wrapping compose correctly)', () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        lgBridge.deviceNames = new Map([[DEVICE_ID, '거실건조기']])
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        try {
            makeMappedDevice(bridge)
            bridge.setControlEnabled(DEVICE_ID, false)

            assert.equal(ha.devices[DEVICE_ID].config!.device.name, '거실건조기')
            assert.equal(ha.devices[DEVICE_ID].config!.components.power, undefined)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a disabled device keeps publishing its own state to HA - only the HA-to-device direction is blocked', () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        makeMappedDevice(bridge)
        try {
            bridge.setControlEnabled(DEVICE_ID, false)

            const dev = bridge.haDevices.get(DEVICE_ID) as AABBDevice
            dev.publishProperty('remaining_minutes', 42)

            assert.equal(ha.devices[DEVICE_ID].properties.remaining_minutes, 42)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a device already disabled in a persisted ControlState starts filtered, before it even connects', () => {
        const ha = new MockHAConnection()
        const controlState = mockControlState([DEVICE_ID])
        const bridge = new HA_bridge(ha.asConnection(), undefined, controlState)
        try {
            assert.equal(bridge.isControlEnabled(DEVICE_ID), false)

            makeMappedDevice(bridge)
            assert.equal(ha.devices[DEVICE_ID].config!.components.power, undefined)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('toggling control writes the change through to ControlState, so it survives a restart', () => {
        const ha = new MockHAConnection()
        const controlState = mockControlState()
        const bridge = new HA_bridge(ha.asConnection(), undefined, controlState)
        try {
            makeMappedDevice(bridge)

            bridge.setControlEnabled(DEVICE_ID, false)
            assert.deepEqual(controlState.getDisabledDevices(), [DEVICE_ID])

            bridge.setControlEnabled(DEVICE_ID, true)
            assert.deepEqual(controlState.getDisabledDevices(), [])
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('without a ControlState (e.g. most tests above), the toggle still works but nothing is persisted', () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        try {
            makeMappedDevice(bridge)
            bridge.setControlEnabled(DEVICE_ID, false)
            assert.equal(bridge.isControlEnabled(DEVICE_ID), false)
            assert.equal(ha.devices[DEVICE_ID].config!.components.power, undefined)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })
})
