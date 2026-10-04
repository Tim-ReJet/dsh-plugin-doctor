/**
 * The host-plugin seam: one registration on `ctx.tools`, with the tool's validated execution path.
 * The harness peer packages are not installable in every checkout, so this module skips itself
 * rather than failing when they are absent — the audit engine is covered without them.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let plugin = null
let unavailable = null
try {
  plugin = await import('../src/index.js')
} catch (error) {
  unavailable = error instanceof Error ? error.message : String(error)
}

const skip = plugin === null ? `harness peer modules are not resolvable here: ${unavailable}` : false
const repoRoot = new URL('..', import.meta.url).pathname

test('the module exports the Cordis plugin shape', { skip }, () => {
  assert.equal(plugin.name, 'plugin-doctor')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function', 'Config must be a schema, not a plain object')
})

test('Config fills the row defaults', { skip }, () => {
  assert.deepEqual({ ...plugin.Config({}) }, { strict: false, network: false, path: '.' })
})

test('apply registers plugin_doctor with a validated execution path', { skip }, async () => {
  const registered = []
  plugin.apply({ tools: { register: (tool) => registered.push(tool) } }, { strict: false, network: false, path: repoRoot })
  assert.equal(registered.length, 1)
  const tool = registered[0]
  assert.equal(tool.name, 'plugin_doctor')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['path', 'strict', 'network'])
  assert.deepEqual(tool.parameters.required ?? [], [])

  const value = await tool.execute({ path: repoRoot }, {})
  assert.equal(typeof value.ok, 'boolean')
  assert.equal(typeof value.errors, 'number')
  assert.equal(typeof value.warnings, 'number')
  assert.match(value.report, /^dsh-plugin-doctor · /)
  assert.equal(value.ok, value.errors === 0)
})

test('a wrongly typed argument is rejected by the tool schema', { skip }, async () => {
  const registered = []
  plugin.apply({ tools: { register: (tool) => registered.push(tool) } }, {})
  await assert.rejects(() => registered[0].execute({ strict: 'yes' }, {}))
})
