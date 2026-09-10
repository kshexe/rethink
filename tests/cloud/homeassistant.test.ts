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

test('publishConfig applies the $this/$rethink/$deviceid topic replacements and publishes to the device-discovery topic', () => {
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

    assert.equal(published.length, 1)
    const payload = JSON.parse(published[0].payload)
    assert.equal(payload.device.identifiers, 'dev-1')
    assert.equal(payload.components.power.state_topic, 'rethink/dev-1/power')
    assert.equal(payload.components.power.command_topic, 'rethink/dev-1/power/set')
    assert.equal(published[0].topic, 'homeassistant/device/rethink/dev-1/config')
})

test('publishConfig does not inject any entity-naming fields of its own - HA derives entity_id from `name` itself', () => {
    // See homeassistant.ts's publishConfig() for the history here: this codebase tried both a
    // per-component `object_id` field and a codebase-computed `default_entity_id`, and reverted
    // both. The actual fix for the bug that prompted them (a Korean device/compartment name
    // slugifying into gibberish) is to keep `name` itself plain ASCII at the source - see
    // 3REK2G03VI200S_2.ts.
    const { conn, published } = makeConnection()
    const config: DeviceDiscovery = {
        device: { identifiers: '$deviceid', model: '2REF21EBNSX_3' },
        origin: { name: 'rethink' },
        components: {
            express_mode: { platform: 'switch', unique_id: '$deviceid-express_mode', name: 'Express mode' },
        },
    }

    conn.publishConfig('dev-1', config)

    const payload = JSON.parse(published[0].payload)
    assert.equal('object_id' in payload.components.express_mode, false)
    assert.equal('default_entity_id' in payload.components.express_mode, false)
    assert.equal('entityIdPrefix' in payload, false)
})
