/**
 * Exponential backoff with jitter for a "reconnect forever" loop. Used by bridge/index.ts's
 * reconnect to the real LG cloud: a fixed retry interval either hammers a real outage there at
 * full rate for as long as it lasts, or is slow to recover from a one-off blip if set
 * conservatively to begin with. Backing off (and resetting once a connection actually succeeds)
 * gets both - fast recovery from the common case (a blip that clears on the first retry), gentler
 * long-run retry rate against an actual outage.
 *
 * Ported from anszom/rethink-adjacent Rust rewrite rusthinq's `backoff.rs`, which splits this into
 * a fast/low-cap profile for a same-LAN control plane and a slower/higher-cap one for a real
 * third-party cloud; only the latter applies here, since this project's only "reconnect forever"
 * loop is the bridge's connection to LG's cloud.
 */
export class ExponentialBackoff {
    private current: number

    constructor(
        private readonly initial: number,
        private readonly max: number,
    ) {
        this.current = initial
    }

    /**
     * For the bridge's connection to LG's real cloud - one per bridged device, all reconnecting
     * independently. Matches rusthinq's own external-upstream profile (2s / 60s): a sustained
     * outage backs off to every 60s rather than hammering LG's cloud every 5s forever, and the
     * common case (one blip, first retry succeeds) recovers faster than this project's previous
     * fixed 5s interval did.
     */
    static forLgCloud(): ExponentialBackoff {
        return new ExponentialBackoff(2000, 60_000)
    }

    /** The delay before the next attempt; doubles (capped at `max`) for next time. */
    nextDelay(): number {
        const base = this.current
        this.current = Math.min(this.current * 2, this.max)
        return jitter(base)
    }

    /** Call once a connection attempt actually succeeds, so the next failure streak starts over. */
    reset() {
        this.current = this.initial
    }
}

// +/-20% so several callers hitting the same outage at once (every bridged device losing LG's
// cloud together) don't all retry in lockstep.
function jitter(base: number): number {
    return Math.round(base * (0.8 + Math.random() * 0.4))
}
