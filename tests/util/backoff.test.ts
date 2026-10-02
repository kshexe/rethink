import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { ExponentialBackoff } from '@/util/backoff'

// Jitter is +/-20%; assert the delay stays within that band of `base` instead of pinning an exact
// number.
function assertNear(actual: number, base: number) {
    assert.ok(actual >= base * 0.8 && actual <= base * 1.2, `${actual} not within +/-20% of ${base}`)
}

describe('ExponentialBackoff', () => {
    test('doubles each call, within jitter', () => {
        const backoff = new ExponentialBackoff(1000, 60_000)
        assertNear(backoff.nextDelay(), 1000)
        assertNear(backoff.nextDelay(), 2000)
        assertNear(backoff.nextDelay(), 4000)
        assertNear(backoff.nextDelay(), 8000)
    })

    test('caps at max instead of doubling forever', () => {
        const backoff = new ExponentialBackoff(1000, 3000)
        assertNear(backoff.nextDelay(), 1000)
        assertNear(backoff.nextDelay(), 2000)
        assertNear(backoff.nextDelay(), 3000) // would be 4000 uncapped
        assertNear(backoff.nextDelay(), 3000) // stays at the cap
    })

    test('reset() starts the next failure streak back at the initial delay', () => {
        const backoff = new ExponentialBackoff(1000, 60_000)
        backoff.nextDelay()
        backoff.nextDelay() // now at 4000 for the *next* call
        backoff.reset()
        assertNear(backoff.nextDelay(), 1000)
    })

    test('forLgCloud matches the external-upstream profile this was ported from (2s/60s)', () => {
        const backoff = ExponentialBackoff.forLgCloud()
        assertNear(backoff.nextDelay(), 2000)
        assertNear(backoff.nextDelay(), 4000)
    })
})
