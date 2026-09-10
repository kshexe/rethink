import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { JSONControlState } from '@/cloud/control_state'

// os.tmpdir() rather than a hardcoded /tmp: the latter doesn't exist on a Windows dev box and
// fails every test in the file - see tests/util/lgcloud/state.test.ts for that exact bug.
function tmpPath(name: string) {
    return path.join(os.tmpdir(), name)
}

test('getDisabledDevices returns an empty list when the file is missing', () => {
    const state = new JSONControlState(tmpPath('rethink-test-no-such-control-state.json'))
    assert.deepEqual(state.getDisabledDevices(), [])
})

test('setDisabledDevices then getDisabledDevices round-trips the list', () => {
    const p = tmpPath('rethink-test-control-state-roundtrip.json')
    const state = new JSONControlState(p)
    try {
        state.setDisabledDevices(['dev-a', 'dev-b'])
        assert.deepEqual(state.getDisabledDevices(), ['dev-a', 'dev-b'])

        state.setDisabledDevices([])
        assert.deepEqual(state.getDisabledDevices(), [])
    } finally {
        fs.unlinkSync(p)
    }
})

test('getDisabledDevices tolerates a corrupt file rather than throwing', () => {
    const p = tmpPath('rethink-test-control-state-corrupt.json')
    fs.writeFileSync(p, '{not valid json')
    try {
        assert.deepEqual(new JSONControlState(p).getDisabledDevices(), [])
    } finally {
        fs.unlinkSync(p)
    }
})
