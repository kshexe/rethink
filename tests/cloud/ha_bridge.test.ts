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
        const bridge = new HA_bridge(ha.asConnection(), lgBridge, undefined, 10)
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
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a namesChanged event renames an already-mapped device', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        const bridge = new HA_bridge(ha.asConnection(), lgBridge, undefined, 10)
        await makeMappedDevice(bridge)
        try {
            assert.equal(ha.devices[DEVICE_ID].config!.device.name, 'LG Dryer')

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
        const bridge = new HA_bridge(ha.asConnection(), lgBridge, undefined, 5000)
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
        const bridge = new HA_bridge(ha.asConnection(), lgBridge, undefined, 10)
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

describe('HA_bridge control enable/disable', () => {
    test('is enabled by default: a command from HA reaches the appliance', async () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        const thinq = await makeMappedDevice(bridge)
        try {
            assert.equal(bridge.isControlEnabled(DEVICE_ID), true)
            ha.setProperty(DEVICE_ID, 'power', 'command', 'ON')
            assert.equal(thinq.outbox.length, 1)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('disabling control removes the switch component from the published config, leaving the sensor', async () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        await makeMappedDevice(bridge)
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

    test('disabling control actually sends the two-step removal HA requires - an empty {platform} marker, then an update that omits the component - not just a single publish that omits it', async () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        await makeMappedDevice(bridge)
        try {
            const publishes: Record<string, unknown>[] = []
            const originalPublishConfig = ha.publishConfig.bind(ha)
            ha.publishConfig = (id, config) => {
                publishes.push(structuredClone(config.components) as Record<string, unknown>)
                originalPublishConfig(id, config)
            }

            bridge.setControlEnabled(DEVICE_ID, false)

            assert.equal(
                publishes.length,
                2,
                'a plain single omitting publish is not enough for HA to remove the entity',
            )

            const marker = publishes[0].power as Record<string, unknown>
            assert.deepEqual(
                Object.keys(marker).sort(),
                ['platform', 'unique_id'],
                'step 1: power reduced to an empty marker (still naming the component, per HA docs)',
            )
            assert.equal(marker.platform, 'switch')

            assert.equal(publishes[1].power, undefined, 'step 2: power omitted entirely')
            assert.ok(publishes[1].remaining_minutes, 'the sensor was never touched by either step')
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a command still cannot reach the appliance while disabled, and works again once re-enabled', async () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        const thinq = await makeMappedDevice(bridge)
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

    test('a disabled device with a linked LG account still gets its real name on the filtered config (name and control-filter wrapping compose correctly)', async () => {
        const ha = new MockHAConnection()
        const lgBridge = new LgCloudBridge(state(), new DeviceManager())
        lgBridge.deviceNames = new Map([[DEVICE_ID, '거실건조기']])
        const bridge = new HA_bridge(ha.asConnection(), lgBridge)
        try {
            await makeMappedDevice(bridge)
            bridge.setControlEnabled(DEVICE_ID, false)

            assert.equal(ha.devices[DEVICE_ID].config!.device.name, '거실건조기')
            assert.equal(ha.devices[DEVICE_ID].config!.components.power, undefined)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a disabled device keeps publishing its own state to HA - only the HA-to-device direction is blocked', async () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        await makeMappedDevice(bridge)
        try {
            bridge.setControlEnabled(DEVICE_ID, false)

            const dev = bridge.haDevices.get(DEVICE_ID) as AABBDevice
            dev.publishProperty('remaining_minutes', 42)

            assert.equal(ha.devices[DEVICE_ID].properties.remaining_minutes, 42)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('a device already disabled in a persisted ControlState starts filtered, before it even connects', async () => {
        const ha = new MockHAConnection()
        const controlState = mockControlState([DEVICE_ID])
        const bridge = new HA_bridge(ha.asConnection(), undefined, controlState)
        try {
            assert.equal(bridge.isControlEnabled(DEVICE_ID), false)

            await makeMappedDevice(bridge)
            assert.equal(ha.devices[DEVICE_ID].config!.components.power, undefined)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('toggling control writes the change through to ControlState, so it survives a restart', async () => {
        const ha = new MockHAConnection()
        const controlState = mockControlState()
        const bridge = new HA_bridge(ha.asConnection(), undefined, controlState)
        try {
            await makeMappedDevice(bridge)

            bridge.setControlEnabled(DEVICE_ID, false)
            assert.deepEqual(controlState.getDisabledDevices(), [DEVICE_ID])

            bridge.setControlEnabled(DEVICE_ID, true)
            assert.deepEqual(controlState.getDisabledDevices(), [])
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('without a ControlState (e.g. most tests above), the toggle still works but nothing is persisted', async () => {
        const ha = new MockHAConnection()
        const bridge = new HA_bridge(ha.asConnection())
        try {
            await makeMappedDevice(bridge)
            bridge.setControlEnabled(DEVICE_ID, false)
            assert.equal(bridge.isControlEnabled(DEVICE_ID), false)
            assert.equal(ha.devices[DEVICE_ID].config!.components.power, undefined)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })
})
