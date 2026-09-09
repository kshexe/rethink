import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure, record } from '@/cloud/frame-recorder'

const dirs: string[] = []
function freshDir() {
    const d = mkdtempSync(join(tmpdir(), 'frames-'))
    dirs.push(d)
    return d
}
afterEach(() => {
    configure({ days: 0 })
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const meta = { modelId: 'ST_R_ETH01Y_', modelName: 'RX', swVersion: '1' }

describe('frame recorder', () => {
    test('does nothing while disabled (days = 0)', () => {
        const dir = freshDir()
        configure({ dir, days: 0 })
        record('id-1', meta, 'to-device', Buffer.from('aa00bb', 'hex'))
        assert.equal(readdirSync(dir).length, 0)
    })

    test('appends one JSON line per frame to a per-day file', async () => {
        const dir = freshDir()
        configure({ dir, days: 7 })
        record('id-1', meta, 'from-device', Buffer.from('AABBCC', 'hex'))
        record('id-1', meta, 'to-device', Buffer.from('0102', 'hex'))
        await new Promise((r) => setTimeout(r, 50))

        const files = readdirSync(dir)
        assert.equal(files.length, 1)
        assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/)

        const lines = readFileSync(join(dir, files[0]), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
        assert.equal(lines.length, 2)
        assert.deepEqual(
            lines.map((l) => [l.id, l.model, l.dir, l.hex]),
            [
                ['id-1', 'ST_R_ETH01Y_', 'from-device', 'AABBCC'],
                ['id-1', 'ST_R_ETH01Y_', 'to-device', '0102'],
            ],
        )
        assert.ok(!Number.isNaN(Date.parse(lines[0].ts)))
    })

    test('prune drops files older than the retention window, keeps recent ones', async () => {
        const dir = freshDir()
        const old = '2000-01-01.jsonl'
        const recent = new Date().toISOString().slice(0, 10) + '.jsonl'
        writeFileSync(join(dir, old), '{}\n')
        writeFileSync(join(dir, recent), '{}\n')

        configure({ dir, days: 7 }) // runs a prune on configure
        await new Promise((r) => setTimeout(r, 50))

        const files = readdirSync(dir).sort()
        assert.ok(!files.includes(old), 'old file should be pruned')
        assert.ok(files.includes(recent), 'recent file should remain')
    })

    test('an empty buffer is not recorded', async () => {
        const dir = freshDir()
        configure({ dir, days: 7 })
        record('id-1', meta, 'to-device', Buffer.alloc(0))
        await new Promise((r) => setTimeout(r, 50))
        assert.equal(readdirSync(dir).length, 0)
    })

    async function linesIn(dir: string) {
        await new Promise((r) => setTimeout(r, 50))
        const f = readdirSync(dir)[0]
        return f ? readFileSync(join(dir, f), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : []
    }

    test('identical from-device frames are recorded once; a change is recorded again', async () => {
        const dir = freshDir()
        configure({ dir, days: 7 })
        const a = Buffer.from('AA0100BB', 'hex')
        const b = Buffer.from('AA0102BB', 'hex')
        record('id-1', meta, 'from-device', a)
        record('id-1', meta, 'from-device', a)
        record('id-1', meta, 'from-device', a)
        record('id-1', meta, 'from-device', b)
        record('id-1', meta, 'from-device', a) // changed back - kept
        assert.deepEqual((await linesIn(dir)).map((l) => l.hex), ['AA0100BB', 'AA0102BB', 'AA0100BB'])
    })

    test('dedup is per device', async () => {
        const dir = freshDir()
        configure({ dir, days: 7 })
        record('id-1', meta, 'from-device', Buffer.from('AA00BB', 'hex'))
        record('id-2', meta, 'from-device', Buffer.from('AA00BB', 'hex'))
        assert.deepEqual((await linesIn(dir)).map((l) => l.id), ['id-1', 'id-2'])
    })

    test('to-device commands are always recorded, even identical ones', async () => {
        const dir = freshDir()
        configure({ dir, days: 7 })
        const cmd = Buffer.from('AA09F0241001008DBB', 'hex')
        record('id-1', meta, 'to-device', cmd)
        record('id-1', meta, 'to-device', cmd)
        assert.equal((await linesIn(dir)).filter((l) => l.dir === 'to-device').length, 2)
    })
})
