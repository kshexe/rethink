import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Connection } from '@/cloud/homeassistant'
import type { DeviceDiscovery } from '@/cloud/homeassistant'
import type { HAConfig } from '@/util/config'

const CONFIG: HAConfig = {
    // Never actually reached - mqtt.connect() only schedules a background connection attempt and
    // does not throw synchronously for an unreachable/bogus broker, which is all these tests need.
    mqtt_url: 'mqtt://127.0.0.1:1',
    discovery_prefix: 'homeassistant',
    rethink_prefix: 'rethink',
    mqtt_user: 'user',
    mqtt_pass: 'pass',
}

function makeConnection() {
    const conn = new Connection(CONFIG)
    conn.client.on('error', () => {}) // a real connection attempt to 127.0.0.1:1 will fail; ignore
    conn.client.end(true) // and don't let it keep retrying in the background for the rest of the run
    const published: { topic: string; payload: string }[] = []
    conn.client.publish = ((topic: string, payload: string) => {
        published.push({ topic, payload })
    }) as typeof conn.client.publish
    return { conn, published }
}

test('publishConfig gives every component its own key as object_id, so HA does not have to guess one from `name`', () => {
    const { conn, published } = makeConnection()
    const config: DeviceDiscovery = {
        device: { identifiers: '$deviceid' },
        origin: { name: 'rethink' },
        components: {
            express_mode: { platform: 'switch', unique_id: '$deviceid-express_mode', name: 'Express mode' },
            fridge_temp: { platform: 'number', unique_id: '$deviceid-fridge_temp', name: 'Fridge temperature' },
        },
    }

    conn.publishConfig('dev-1', config)

    assert.equal(published.length, 1)
    const payload = JSON.parse(published[0].payload)
    assert.equal(payload.components.express_mode.object_id, 'express_mode')
    assert.equal(payload.components.fridge_temp.object_id, 'fridge_temp')
})

test('publishConfig leaves an explicitly-set object_id alone', () => {
    const { conn, published } = makeConnection()
    const config: DeviceDiscovery = {
        device: { identifiers: '$deviceid' },
        origin: { name: 'rethink' },
        components: {
            express_mode: {
                platform: 'switch',
                unique_id: '$deviceid-express_mode',
                name: 'Express mode',
                // @ts-expect-error object_id isn't in ComponentInfo's static type, same as every
                // other MQTT-specific field devices pass through allowExtendedType()
                object_id: 'custom_slug',
            },
        },
    }

    conn.publishConfig('dev-1', config)

    const payload = JSON.parse(published[0].payload)
    assert.equal(payload.components.express_mode.object_id, 'custom_slug')
})

test('publishConfig still applies the $this/$rethink/$deviceid topic replacements alongside the new object_id', () => {
    const { conn, published } = makeConnection()
    const config: DeviceDiscovery = {
        device: { identifiers: '$deviceid' },
        origin: { name: 'rethink' },
        components: {
            power: {
                platform: 'switch',
                unique_id: '$deviceid-power',
                name: 'Power',
                // @ts-expect-error state_topic/command_topic aren't in ComponentInfo's static
                // type, same as every other MQTT-specific field devices pass through
                // allowExtendedType()
                state_topic: '$this/power',
                command_topic: '$this/power/set',
            },
        },
    }

    conn.publishConfig('dev-1', config)

    const payload = JSON.parse(published[0].payload)
    assert.equal(payload.device.identifiers, 'dev-1')
    assert.equal(payload.components.power.state_topic, 'rethink/dev-1/power')
    assert.equal(payload.components.power.command_topic, 'rethink/dev-1/power/set')
    assert.equal(payload.components.power.object_id, 'power')
    assert.equal(published[0].topic, 'homeassistant/device/rethink/dev-1/config')
})
