/*
 * Rolling on-disk record of every raw device frame, both directions, so an unrecognised
 * command or a state byte no handler reads can be traced back weeks later against "what was
 * pressed in the app at that time".
 *
 * One JSON-lines file per UTC day under the configured directory (default /share/rethink/frames,
 * browsable over Samba / the VS Code add-on). Each line:
 *
 *   {"ts":"2026-09-09T04:53:04.794Z","id":"<uuid>","name":"거실에어컨","model":"CST_570004_WW",
 *    "dir":"to-device"|"from-device","hex":"AA0DF0E5...BB"}
 *
 * Disabled unless frame_log_days > 0. Files older than that many days are pruned on startup and
 * once a day after. Every failure here is swallowed - recording must never disturb the frame path.
 */
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import log from '@/util/logging'
import type { Metadata } from './thinq'

type Dir = 'to-device' | 'from-device'

let enabled = false
let baseDir = '/share/rethink/frames'
let keepDays = 0
let pruneTimer: NodeJS.Timeout | undefined

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

function dayStamp(d = new Date()): string {
    return d.toISOString().slice(0, 10)
}

export function configure(opts: { dir?: string; days?: number }): void {
    if (opts.dir) baseDir = opts.dir
    keepDays = Math.max(0, Math.floor(opts.days ?? 0))
    enabled = keepDays > 0

    if (pruneTimer) clearInterval(pruneTimer)
    pruneTimer = undefined
    if (!enabled) return

    log('status', `frame recorder on: ${baseDir}, keeping ${keepDays} day(s)`)
    void prune()
    pruneTimer = setInterval(() => void prune(), 24 * 60 * 60 * 1000)
    pruneTimer.unref?.()
}

export function record(id: string, meta: Metadata | undefined, dir: Dir, buf: Buffer): void {
    if (!enabled || !buf?.length) return
    const line =
        JSON.stringify({
            ts: new Date().toISOString(),
            id,
            model: meta?.modelId,
            dir,
            hex: buf.toString('hex').toUpperCase(),
        }) + '\n'
    void write(line)
}

async function write(line: string): Promise<void> {
    try {
        await mkdir(baseDir, { recursive: true })
        await appendFile(join(baseDir, `${dayStamp()}.jsonl`), line)
    } catch (err) {
        // A missing /share (add-on without the share mapping) lands here once per frame; drop to
        // disabled so it is one log line, not a flood.
        enabled = false
        log('status', `frame recorder disabled - cannot write ${baseDir}: ${err}`)
    }
}

async function prune(): Promise<void> {
    try {
        const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        for (const name of await readdir(baseDir)) {
            const m = FILE_RE.exec(name)
            if (m && m[1] < cutoff) await unlink(join(baseDir, name)).catch(() => {})
        }
    } catch {
        // directory not there yet - nothing to prune
    }
}
