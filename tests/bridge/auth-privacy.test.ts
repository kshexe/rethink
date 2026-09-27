import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

// Adapted from upstream anszom/rethink (redact LG account profile data from logs): auth() used to
// print the whole profile response on a status-check failure and a "Welcome <userID>!" line on
// success - both put the account's real LG login (an email/phone) in plain logs for no operational
// reason (the thrown Error / the headers set right after already carry what callers need).
test('LG authentication does not log account profile data', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../bridge/thinqApi.ts'), 'utf8')

    assert.doesNotMatch(source, /console\.log\(profile\)/)
    assert.doesNotMatch(source, /profile\.account\.userID/)
})
