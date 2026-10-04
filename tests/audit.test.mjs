/**
 * Fixture-driven tests for the audit engine. Each fixture is a throwaway repository in the system
 * temp directory, so the suite is hermetic: no network, no writes inside the checked-out repo, and
 * the only external program it needs is git.
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { auditRepository, emitEntry, fetchTopics, implementationFiles, scanPatchRows } from '../src/audit.js'
import { formatReport } from '../src/report.js'

const created = []
after(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

/**
 * Write a fixture repository.
 * @param {Record<string, unknown>} files - repo-relative path to contents.
 * @param {{git?: boolean, commitISO?: string, remote?: string}} [options] - git options.
 * @returns {string} the fixture root.
 */
function fixture(files, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-doctor-'))
  created.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  }
  if (options.git) {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
      ...(options.commitISO ? { GIT_AUTHOR_DATE: options.commitISO, GIT_COMMITTER_DATE: options.commitISO } : {}),
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env })
    execFileSync('git', ['add', '-A'], { cwd: root, env })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root, env })
    if (options.remote) execFileSync('git', ['remote', 'add', 'origin', options.remote], { cwd: root, env })
  }
  return root
}

const GOOD_PATCH = '- insert:\n    - id: example\n      name: dsh-example\n'
const GOOD_CODE = { 'src/index.js': 'export const name = "example"\n\nexport function apply() {}\n' }
const GOOD_PKG = {
  name: 'dsh-example',
  version: '0.1.0',
  description: 'Example plugin that registers one host row for fixture tests.',
  type: 'module',
  main: 'src/index.js',
  repository: { type: 'git', url: 'git+https://github.com/acme/dsh-example.git' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.1-rc.1 <0.1.2-0' },
}

/** @param {object} result @param {string} id */
function check(result, id) {
  const found = result.checks.find((entry) => entry.id === id)
  assert.ok(found, `no ${id} check in the result`)
  return found
}

/** @returns {Record<string, unknown>} a fresh copy of the healthy package.json */
function goodPackage(overrides = {}) {
  return { ...structuredClone(GOOD_PKG), ...overrides }
}

test('a healthy repository passes with no errors and no warnings', async () => {
  const root = fixture({ 'package.json': goodPackage(), 'cordis.patch.yml': GOOD_PATCH, ...GOOD_CODE })
  const result = await auditRepository(root, { harnessVersion: '0.1.1-rc.2' })
  assert.equal(result.errors, 0, formatReport(result))
  assert.equal(result.warnings, 0, formatReport(result))
  assert.equal(result.ok, true)
  assert.ok(result.skipped >= 1, 'the offline checks should report themselves as skipped')
})

test('dsh.client without dsh.bundle is reported as the common rejection', async () => {
  const root = fixture({ 'package.json': goodPackage({ dsh: { client: { platform: 'web' } } }), ...GOOD_CODE })
  const result = await auditRepository(root)
  const bundle = check(result, 'manifest.bundle')
  assert.equal(bundle.status, 'fail')
  assert.match(bundle.title, /dsh\.client/)
  assert.equal(result.errors, 1)
  assert.equal(result.ok, false)
})

test('a missing bundle patch file fails', async () => {
  const root = fixture({ 'package.json': goodPackage(), ...GOOD_CODE })
  const result = await auditRepository(root)
  assert.equal(check(result, 'manifest.bundle-patch-file').status, 'fail')
})

test('a patch that is not a sequence fails', async () => {
  const root = fixture({ 'package.json': goodPackage(), 'cordis.patch.yml': 'plugin:\n  id: example\n', ...GOOD_CODE })
  const result = await auditRepository(root)
  assert.equal(check(result, 'manifest.bundle-patch-rows').status, 'fail')
})

test('a patch that never names the package fails', async () => {
  const root = fixture({ 'package.json': goodPackage(), 'cordis.patch.yml': '- insert:\n    - id: other\n      name: someone-else\n', ...GOOD_CODE })
  const result = await auditRepository(root)
  const rows = check(result, 'manifest.bundle-patch-rows')
  assert.equal(rows.status, 'fail')
  assert.match(rows.title, /does not reference|no patch row references/)
})

test('a peer range that cannot admit the harness prerelease fails and says why', async () => {
  const root = fixture({
    'package.json': goodPackage({ peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.7' } }),
    'cordis.patch.yml': GOOD_PATCH,
    ...GOOD_CODE,
  })
  const result = await auditRepository(root, { harnessVersion: '0.1.1-rc.2' })
  const peer = check(result, 'manifest.peer-prerelease')
  assert.equal(peer.status, 'fail')
  assert.match(peer.detail, /no comparator carries a prerelease tag on the 0\.1\.1-rc\.2 tuple/)
})

test('a wildcard peer range fails as excluding every prerelease build', async () => {
  const root = fixture({
    'package.json': goodPackage({ peerDependencies: { '@deepseek-ai/dsh-tools': '*' } }),
    'cordis.patch.yml': GOOD_PATCH,
    ...GOOD_CODE,
  })
  const result = await auditRepository(root, { harnessVersion: '0.1.1-rc.2' })
  const peer = check(result, 'manifest.peer-prerelease')
  assert.equal(peer.status, 'fail')
  assert.match(peer.detail, /no comparator in the range carries a prerelease tag/)
})

test('an explicit prerelease branch per tuple passes', async () => {
  const root = fixture({
    'package.json': goodPackage({
      peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.1-rc.1 <0.1.2-0 || >=0.2.0-rc.1 <0.2.1-0' },
    }),
    'cordis.patch.yml': GOOD_PATCH,
    ...GOOD_CODE,
  })
  const result = await auditRepository(root, { harnessVersion: '0.2.0-rc.2' })
  assert.equal(check(result, 'manifest.peer-prerelease').status, 'pass')
})

test('an official package in dependencies is a warning, and strict mode fails the result', async () => {
  const root = fixture({
    'package.json': goodPackage({ dependencies: { '@deepseek-ai/schemastery': '^3.18.1' } }),
    'cordis.patch.yml': GOOD_PATCH,
    ...GOOD_CODE,
  })
  const result = await auditRepository(root, { harnessVersion: '0.1.1-rc.2' })
  assert.equal(check(result, 'manifest.peer-dependencies').status, 'fail')
  assert.equal(result.errors, 0)
  assert.equal(result.warnings, 1)
  assert.equal(result.ok, true)
  const strict = await auditRepository(root, { harnessVersion: '0.1.1-rc.2', strict: true })
  assert.equal(strict.ok, false)
})

test('marketing language in the description is a warning', async () => {
  const root = fixture({
    'package.json': goodPackage({ description: 'The ultimate best-in-class plugin, seamlessly blazing fast.' }),
    'cordis.patch.yml': GOOD_PATCH,
    ...GOOD_CODE,
  })
  const result = await auditRepository(root, { harnessVersion: '0.1.1-rc.2' })
  const marketing = check(result, 'description.marketing')
  assert.equal(marketing.status, 'fail')
  assert.match(marketing.title, /best|blazing|seamless|ultimate/)
})

test('a bundle with a patch but no code is both an error and the meta-package warning', async () => {
  const root = fixture({ 'package.json': goodPackage({ main: undefined }), 'cordis.patch.yml': GOOD_PATCH })
  const result = await auditRepository(root)
  assert.equal(check(result, 'repo.implementation').status, 'fail')
  assert.equal(check(result, 'packaging.meta-bundle').status, 'fail')
})

test('repository age is read from git history', async () => {
  const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
  const oldRoot = fixture({ 'package.json': goodPackage(), 'cordis.patch.yml': GOOD_PATCH, ...GOOD_CODE }, { git: true, commitISO: old })
  const oldResult = await auditRepository(oldRoot, { harnessVersion: '0.1.1-rc.2' })
  assert.equal(check(oldResult, 'repo.age').status, 'pass')

  const freshRoot = fixture({ 'package.json': goodPackage(), 'cordis.patch.yml': GOOD_PATCH, ...GOOD_CODE }, { git: true })
  const freshResult = await auditRepository(freshRoot)
  assert.equal(check(freshResult, 'repo.age').status, 'fail')
})

test('the topic check reads GitHub and reports a missing topic', async () => {
  const files = { 'package.json': goodPackage(), 'cordis.patch.yml': GOOD_PATCH, ...GOOD_CODE }
  const options = {
    git: true,
    remote: 'https://github.com/acme/dsh-example.git',
  }
  const execFileImpl = () => { throw new Error('gh is unavailable in tests') }
  const present = fixture(files, options)
  const presentResult = await auditRepository(present, {
    network: true,
    execFileImpl,
    fetchImpl: async () => ({ ok: true, json: async () => ({ topics: ['dsh', 'dsh-plugin'] }) }),
  })
  assert.equal(check(presentResult, 'repo.topic').status, 'pass')

  const absent = fixture(files, options)
  const absentResult = await auditRepository(absent, {
    network: true,
    execFileImpl,
    fetchImpl: async () => ({ ok: true, json: async () => ({ topics: ['dsh'] }) }),
  })
  const topic = check(absentResult, 'repo.topic')
  assert.equal(topic.status, 'fail')
  assert.match(topic.fix, /names\[\]=dsh-plugin/)

  const broken = fixture(files, options)
  const brokenResult = await auditRepository(broken, {
    network: true,
    execFileImpl,
    fetchImpl: async () => { throw new Error('offline') },
  })
  assert.equal(check(brokenResult, 'repo.topic').status, 'skip')
})

test('a patch kept outside the repository is a warning, not a pass', async () => {
  const root = fixture({
    'package.json': goodPackage({ dsh: { bundle: { patch: '../outside.yml' } } }),
    ...GOOD_CODE,
  })
  writeFileSync(join(root, '..', 'outside.yml'), GOOD_PATCH)
  const result = await auditRepository(root, { harnessVersion: '0.1.1-rc.2' })
  const location = check(result, 'manifest.bundle-patch-location')
  assert.equal(location.status, 'fail')
  assert.match(location.title, /outside the repository/)
  assert.equal(result.errors, 0)
})

test('a peer range this checker cannot model is warned about, never silently dropped', async () => {
  const root = fixture({
    'package.json': goodPackage({ peerDependencies: { '@deepseek-ai/dsh-tools': 'latest' } }),
    'cordis.patch.yml': GOOD_PATCH,
    ...GOOD_CODE,
  })
  const result = await auditRepository(root, { harnessVersion: '0.1.1-rc.2' })
  assert.equal(check(result, 'manifest.peer-range-parsed').status, 'fail')
  assert.equal(check(result, 'manifest.peer-prerelease').status, 'skip')
  assert.equal(result.checks.length, 14, 'a skipped check must still be reported, alongside the parse warning')
  assert.equal(result.errors, 0)
})

test('the gh path reads topics per line instead of mistaking a JSON array for one topic', async () => {
  const oneLineArray = await fetchTopics('acme/dsh-example', { execFileImpl: () => '["cordis-plugin","dsh-plugin"]' })
  assert.deepEqual(oneLineArray, { topics: ['cordis-plugin', 'dsh-plugin'] })
  const perLine = await fetchTopics('acme/dsh-example', { execFileImpl: () => 'dsh\ndsh-plugin\n' })
  assert.deepEqual(perLine, { topics: ['dsh', 'dsh-plugin'] })
  const none = await fetchTopics('acme/dsh-example', { execFileImpl: () => '' })
  assert.deepEqual(none, { topics: [] })
})

test('offline runs say the topic was not checked instead of implying it passed', async () => {
  const root = fixture({ 'package.json': goodPackage(), 'cordis.patch.yml': GOOD_PATCH, ...GOOD_CODE })
  const result = await auditRepository(root)
  const topic = check(result, 'repo.topic')
  assert.equal(topic.status, 'skip')
  assert.equal(result.ok, true, 'a skipped check is not an error')
})

test('the engine audits its own repository cleanly', async () => {
  const root = new URL('..', import.meta.url).pathname
  const result = await auditRepository(root, {
    harnessVersion: '0.1.1-rc.2',
    now: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
  })
  assert.equal(result.errors, 0, formatReport(result, { verbose: true }))
  assert.equal(result.warnings, 0, formatReport(result, { verbose: true }))
})

test('the patch scanner sees nested rows, ids, and names', () => {
  const scan = scanPatchRows([
    '# a comment',
    '- insert:',
    '    - id: plugin-doctor',
    '      name: dsh-plugin-doctor',
    '      config:',
    "        path: '.'",
    '- id: second',
    '  name: other-package',
    '',
  ].join('\n'))
  assert.equal(scan.isSequence, true)
  assert.deepEqual(scan.rows.map((row) => [row.id, row.name]), [
    [null, null],
    ['plugin-doctor', 'dsh-plugin-doctor'],
    ['second', 'other-package'],
  ])
  assert.equal(scanPatchRows('[]').rows.length, 0)
  assert.equal(scanPatchRows('key: value\n').isSequence, false)
})

test('implementation files are found through main, files, and the fallback scan', () => {
  const root = fixture({ 'package.json': goodPackage({ main: undefined, files: ['dist'] }), 'dist/bundle.js': 'export {}\n' })
  assert.deepEqual(implementationFiles(root, { files: ['dist'] }), ['dist/bundle.js'])
  const fallback = fixture({ 'package.json': goodPackage({ main: undefined }), 'src/plugin.ts': 'export {}\n' })
  assert.deepEqual(implementationFiles(fallback, {}), ['src/plugin.ts'])
})

test('the catalog entry quotes a description that contains a colon', () => {
  const entry = emitEntry({ description: 'Audit tools: manifests and topics.' }, 'acme/dsh-example', { category: 'dev' })
  assert.match(entry, /^# data\/plugins\/acme__dsh-example\.yml$/m)
  assert.match(entry, /^url: https:\/\/github\.com\/acme\/dsh-example$/m)
  assert.match(entry, /^name: acme\/dsh-example$/m)
  assert.match(entry, /^category: dev$/m)
  assert.match(entry, /^  en: 'Audit tools: manifests and topics\.'$/m)
})
