/**
 * The prerelease gate is the part of this plugin that is easy to get subtly wrong, so its expected
 * answers are not hand-written: `fixtures/node-semver-table.json` records what node-semver itself
 * answered for every (range, version) pair, and these tests require an exact match.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compareVersions, parseVersion, prereleaseGate, satisfies } from '../src/semver-gate.js'

const table = JSON.parse(readFileSync(new URL('./fixtures/node-semver-table.json', import.meta.url), 'utf8'))

test('agrees with node-semver on every recorded (range, version) pair', () => {
  assert.ok(table.rows.length >= 90, 'the recorded table is unexpectedly small')
  for (const [range, version, expected] of table.rows) {
    assert.equal(satisfies(range, version), expected, `${version} against "${range}"`)
  }
})

test('the recorded table contains the trap it exists to catch', () => {
  const trapped = table.rows.find(([range, version]) => range === '^0.1.0-rc.7' && version === '0.1.1-rc.2')
  assert.deepEqual(trapped, ['^0.1.0-rc.7', '0.1.1-rc.2', false])
})

test('returns null rather than guessing on input it cannot model', () => {
  assert.equal(satisfies('latest', '0.1.1-rc.2'), null)
  assert.equal(satisfies('^1.0.0', 'not-a-version'), null)
  assert.equal(prereleaseGate('not a range at all', '0.1.1-rc.2').status, 'unknown')
})

test('names why a range excludes a prerelease build', () => {
  assert.deepEqual(prereleaseGate('^0.1.0-rc.7', '0.1.1-rc.2'), { status: 'fail', reason: 'no-comparator-on-tuple' })
  assert.deepEqual(prereleaseGate('*', '0.1.1-rc.2'), { status: 'fail', reason: 'no-prerelease-comparator' })
  assert.deepEqual(prereleaseGate('>=0.0.1-rc.1 <0.2.0', '0.1.1-rc.2'), { status: 'fail', reason: 'no-comparator-on-tuple' })
  assert.equal(prereleaseGate('>=0.1.1-rc.1 <0.1.2-0', '0.1.1-rc.2').status, 'ok')
  assert.equal(prereleaseGate('>=0.1.1-rc.1 <0.1.2-0 || >=0.2.0-rc.1 <0.2.1-0', '0.2.0-rc.2').status, 'ok')
})

test('a release harness version is not restricted by the prerelease gate', () => {
  assert.equal(prereleaseGate('^4.0.1', '4.0.1').status, 'ok')
  assert.match(prereleaseGate('^4.0.1', '4.0.1').note, /release/)
})

test('without a harness version it falls back to the structural check', () => {
  assert.equal(prereleaseGate('>=0.1.1-rc.1 <0.1.2-0', null).status, 'ok')
  assert.equal(prereleaseGate('^1.2.3', null).reason, 'no-prerelease-comparator')
})

test('version ordering follows node-semver, including prerelease identifiers', () => {
  const order = ['0.1.1-alpha.1', '0.1.1-alpha.2', '0.1.1-rc.1', '0.1.1-rc.2', '0.1.1', '0.2.0-rc.1']
  for (let index = 0; index < order.length - 1; index += 1) {
    const left = parseVersion(order[index])
    const right = parseVersion(order[index + 1])
    assert.equal(compareVersions(left, right), -1, `${order[index]} < ${order[index + 1]}`)
    assert.equal(compareVersions(right, left), 1)
  }
  assert.equal(compareVersions(parseVersion('1.0.0+build'), parseVersion('1.0.0')), 0)
})
