/*
 * Persistent hour/day/month/total energy (Wh) accounting for appliances whose local protocol only
 * gives us the appliance's own reset-prone figure: a rethink restart or a cloud-bridge reconnect
 * zeroes a fridge's running counter (2REF21EBNSX_3.ts's `energy_raw_counter`,
 * 3REK2G03VI200S_2.ts's energy total both do this - see their own file headers), and a washer's own
 * counter (FX___S.ts) legitimately restarts every cycle by design. None of that is the calendar
 * boundary a "today"/"this month" figure needs.
 *
 * Callers report each newly-seen Wh delta as it is decoded (deduping repeats of the same on-device
 * report themselves - a report number, an interval key, whatever fits that protocol); this module
 * turns the delta stream into four always-accurate buckets that survive all of the above, one JSON
 * file per device id under /share/rethink/energy/ (browsable the same way frame-recorder's captures
 * are - see cloud/frame-recorder.ts, which this deliberately mirrors the style of).
 *
 * Calendar boundaries are Asia/Seoul, matching the appliance's own locale for "today"/"this month".
 * Modelled on github.com/plplaaa2/rethink's 2RES2VE300UA2.ts, which solves this exact
 * appliance-counter-resets-independently-of-the-calendar problem the same way.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import log from '@/util/logging'

let baseDir = '/share/rethink/energy'

/** Override the storage directory - tests use this to point at a scratch dir; production has no
 *  reason to call it and just gets the default above. */
export function configure(dir: string) {
    baseDir = dir
    cache.clear()
    dirReady = undefined
}

export type EnergyStats = {
    hour: string
    date: string
    month: string
    hourWh: number
    dayWh: number
    monthWh: number
    totalWh: number
}

const cache = new Map<string, EnergyStats>()
let dirReady: Promise<void> | undefined

function localParts(now = Date.now()): { date: string; month: string; hour: string } {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(now)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
    const date = `${get('year')}-${get('month')}-${get('day')}`
    const month = `${get('year')}-${get('month')}`
    const hour = `${date}T${get('hour')}`
    return { date, month, hour }
}

function pathFor(id: string): string {
    return join(baseDir, `${id}.json`)
}

async function ensureDir(): Promise<void> {
    dirReady ??= mkdir(baseDir, { recursive: true }).then(
        () => undefined,
        () => undefined, // a missing /share (add-on without the share mapping) - see frame-recorder.ts
    )
    await dirReady
}

async function load(id: string): Promise<EnergyStats> {
    const cached = cache.get(id)
    if (cached) return cached

    const { date, month, hour } = localParts()
    let stats: EnergyStats = { date, month, hour, hourWh: 0, dayWh: 0, monthWh: 0, totalWh: 0 }
    try {
        const raw = JSON.parse(await readFile(pathFor(id), 'utf-8')) as Partial<EnergyStats>
        stats = {
            date,
            month,
            hour,
            hourWh: raw.hour === hour ? Number(raw.hourWh) || 0 : 0,
            dayWh: raw.date === date ? Number(raw.dayWh) || 0 : 0,
            monthWh: raw.month === month ? Number(raw.monthWh) || 0 : 0,
            totalWh: Number.isFinite(raw.totalWh) ? Number(raw.totalWh) : 0,
        }
    } catch {
        /* first run for this id, or the file is missing/corrupt - start from zero */
    }
    cache.set(id, stats)
    return stats
}

async function save(id: string, stats: EnergyStats): Promise<void> {
    await ensureDir()
    const tmpPath = `${pathFor(id)}.tmp`
    try {
        await writeFile(tmpPath, JSON.stringify(stats))
        await rename(tmpPath, pathFor(id))
    } catch (err) {
        log('status', id, `energy-accumulator: failed to persist: ${err}`)
    }
}

/** Roll over any calendar bucket the wall clock has moved past since the last call, without
 *  adding a delta - so a poll that finds nothing new still keeps hour/day/month current instead
 *  of carrying a stale bucket's figure into the new hour/day/month. */
export async function roll(id: string, now = Date.now()): Promise<EnergyStats> {
    const stats = await load(id)
    const { date, month, hour } = localParts(now)
    let changed = false
    if (stats.hour !== hour) {
        stats.hour = hour
        stats.hourWh = 0
        changed = true
    }
    if (stats.date !== date) {
        stats.date = date
        stats.dayWh = 0
        changed = true
    }
    if (stats.month !== month) {
        stats.month = month
        stats.monthWh = 0
        changed = true
    }
    if (changed) await save(id, stats)
    return stats
}

/** Add a newly-seen Wh delta to all four buckets and persist immediately. */
export async function addDelta(id: string, deltaWh: number, now = Date.now()): Promise<EnergyStats> {
    const stats = await roll(id, now)
    stats.hourWh += deltaWh
    stats.dayWh += deltaWh
    stats.monthWh += deltaWh
    stats.totalWh += deltaWh
    cache.set(id, stats)
    await save(id, stats)
    return stats
}

/** Current bucket values without recording a delta - for publishing on every state frame, not
 *  just when a new energy report arrives. */
export async function current(id: string, now = Date.now()): Promise<EnergyStats> {
    return roll(id, now)
}
