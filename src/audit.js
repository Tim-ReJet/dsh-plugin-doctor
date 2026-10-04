/**
 * The audit engine behind `plugin_doctor` and the `dsh-plugin-doctor` CLI.
 *
 * Every check here mirrors a rule the dsh-plugin directory states for a submission, or a rule the
 * ecosystem's install path enforces silently. The engine is read-only: it never writes to the
 * audited repository, and it makes no network request unless `network: true` is passed.
 * @module dsh-plugin-doctor/audit
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseVersion, prereleaseGate } from './semver-gate.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DOCS = new Set(['README.md', 'README.en.md', 'README.zh.md', 'LICENSE', 'LICENSE.md', 'CHANGELOG.md', 'package.json', 'cordis.patch.yml', 'screenshots.json'])
const IMPLEMENTATION_ROOTS = ['src', 'lib', 'bin', 'index.js', 'index.mjs', 'index.cjs', 'index.ts', 'main.js']
const MARKETING_TERMS = ['best ', 'best-in-class', "world's first", 'worlds first', 'revolutionary', 'blazing', 'lightning-fast', 'ultimate', 'cutting-edge', 'game-changing', 'seamless', 'effortless', 'magical', 'unmatched', 'unleash', 'one-of-a-kind', 'state-of-the-art']
const CATEGORIES = ['agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify', 'dev', 'security', 'remote', 'market', 'fun']

/**
 * @typedef {object} Check
 * @property {string} id - stable check id, dotted by area.
 * @property {'error'|'warn'} level - what a failure of this check means.
 * @property {'pass'|'fail'|'skip'} status - outcome.
 * @property {string} title - one-line statement of the outcome.
 * @property {string} [detail] - the evidence behind a failure or a skip.
 * @property {string} [fix] - the concrete change that resolves a failure.
 */

/**
 * Read and parse a JSON file.
 * @param {string} path - absolute path.
 * @returns {{value: unknown}|{error: string}} the parsed value or the parse error.
 */
function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Run a git command against the repository, returning null instead of throwing.
 * @param {string} root - repository root.
 * @param {string[]} args - git arguments.
 * @returns {string|null} trimmed stdout, or null when git is unavailable or the command fails.
 */
function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim()
  } catch {
    return null
  }
}

/**
 * Resolve the GitHub `owner/repo` slug from the repository's `origin` remote.
 * @param {string} root - repository root.
 * @returns {string|null} the slug, or null when there is no GitHub remote.
 */
export function remoteSlug(root) {
  const url = git(root, ['remote', 'get-url', 'origin'])
  if (url === null) return null
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url)
  return match ? `${match[1]}/${match[2]}` : null
}

/**
 * Scan a cordis.patch.yml for plugin rows without a YAML parser, so the plugin stays
 * dependency-free. It reports the rows it can see: patch entries (`- insert:`) and plugin rows
 * (`- id:`), each with the scalar keys that follow it at a deeper indent.
 * @param {string} text - patch file contents.
 * @returns {{isSequence: boolean, rows: {id: string|null, name: string|null, keys: string[]}[]}} the scan.
 */
export function scanPatchRows(text) {
  const rows = []
  let isSequence = false
  let seenContent = false
  let current = null
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const rowMatch = /^(\s*)-\s*([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (rowMatch) {
      if (!seenContent) {
        seenContent = true
        isSequence = true
      }
      current = { id: null, name: null, keys: [] }
      current.keys.push(rowMatch[2])
      if (rowMatch[2] === 'id') current.id = rowMatch[3].trim().replace(/^['"]|['"]$/g, '')
      if (rowMatch[2] === 'name') current.name = rowMatch[3].trim().replace(/^['"]|['"]$/g, '')
      rows.push(current)
      continue
    }
    if (!seenContent) {
      // The first meaningful line is not a sequence entry: this is not a patch list.
      seenContent = true
      isSequence = /^\s*-/.test(line)
    }
    const keyMatch = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (keyMatch && current) {
      current.keys.push(keyMatch[1])
      if (keyMatch[1] === 'id' && current.id === null) current.id = keyMatch[2].trim().replace(/^['"]|['"]$/g, '')
      if (keyMatch[1] === 'name' && current.name === null) current.name = keyMatch[2].trim().replace(/^['"]|['"]$/g, '')
    }
  }
  return { isSequence, rows }
}

/**
 * Collect implementation files the package actually ships.
 * @param {string} root - repository root.
 * @param {Record<string, unknown>} pkg - parsed package.json.
 * @returns {string[]} repo-relative implementation paths that exist.
 */
export function implementationFiles(root, pkg) {
  const candidates = new Set()
  const add = (value) => {
    if (typeof value !== 'string' || value === '') return
    if (value.startsWith('node:') || value.startsWith('http')) return
    candidates.add(value.replace(/^\.\//, ''))
  }
  add(pkg.main)
  add(pkg.module)
  if (typeof pkg.bin === 'string') add(pkg.bin)
  if (pkg.bin && typeof pkg.bin === 'object') {
    for (const value of Object.values(/** @type {Record<string, unknown>} */ (pkg.bin))) add(value)
  }
  const walkExports = (value) => {
    if (typeof value === 'string') add(value)
    else if (value && typeof value === 'object') for (const nested of Object.values(value)) walkExports(nested)
  }
  walkExports(pkg.exports)
  if (Array.isArray(pkg.files)) for (const value of pkg.files) add(value)

  const found = new Set()
  for (const candidate of candidates) {
    const absolute = resolve(root, candidate)
    if (!existsSync(absolute)) continue
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute)) {
        if (DOCS.has(entry)) continue
        if (/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(entry)) found.add(join(candidate, entry))
      }
      continue
    }
    const base = candidate.split('/').pop() ?? candidate
    if (DOCS.has(base)) continue
    if (/\.(js|mjs|cjs|ts|tsx|jsx|json)$/.test(base) && !base.endsWith('.json')) found.add(candidate)
  }
  if (found.size === 0) {
    for (const candidate of IMPLEMENTATION_ROOTS) {
      const absolute = join(root, candidate)
      if (!existsSync(absolute)) continue
      if (statSync(absolute).isDirectory()) {
        for (const entry of readdirSync(absolute)) {
          if (/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(entry)) found.add(join(candidate, entry))
        }
      } else {
        found.add(candidate)
      }
    }
  }
  return [...found].sort()
}

/**
 * Detect the harness version in use, from an explicit override, the DSH home, or the running
 * package. Best effort: a null answer only downgrades one check to a structural form.
 * @param {{harnessVersion?: string|null, dshHome?: string}} options - audit options.
 * @returns {string|null} a version string, or null when none can be found.
 */
export function detectHarnessVersion(options = {}) {
  if (options.harnessVersion) return options.harnessVersion
  const home = options.dshHome ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  const candidates = [
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const parsed = readJson(candidate)
    const version = parsed.value && typeof parsed.value === 'object' ? /** @type {Record<string, unknown>} */ (parsed.value).version : null
    if (typeof version === 'string' && version !== '') return version
  }
  return null
}

/**
 * Ask GitHub for a repository's topics. Tries the `gh` CLI first, then the REST API with a token
 * from `GH_TOKEN`/`GITHUB_TOKEN`.
 * @param {string} slug - `owner/repo`.
 * @param {{fetchImpl?: typeof fetch, execFileImpl?: typeof execFileSync}} [options] - injectable
 *   process and network seams for tests.
 * @returns {Promise<{topics: string[]}|{error: string}>} the topics or the reason they are unknown.
 */
export async function fetchTopics(slug, options = {}) {
  const run = options.execFileImpl ?? execFileSync
  try {
    const output = run('gh', ['api', `repos/${slug}`, '--jq', '.topics'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const topics = output.split(/\s+/).filter(Boolean)
    if (topics.length > 0) return { topics }
    return { topics: [] }
  } catch {
    // Fall through to the REST API.
  }
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null
  const doFetch = options.fetchImpl ?? fetch
  try {
    const response = await doFetch(`https://api.github.com/repos/${slug}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-plugin-doctor',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
    if (!response.ok) return { error: `GitHub API answered ${response.status}` }
    const body = await response.json()
    const topics = Array.isArray(body.topics) ? body.topics : []
    return { topics }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Render the catalog entry a repository would submit to awesome-dsh-plugin.
 * @param {Record<string, unknown>} pkg - parsed package.json.
 * @param {string} slug - `owner/repo`.
 * @param {{category?: string, subdirectory?: string}} [options] - entry options.
 * @returns {string} the YAML entry file contents.
 */
export function emitEntry(pkg, slug, options = {}) {
  const category = options.category ?? 'dev'
  const repo = `https://github.com/${slug}`
  const url = options.subdirectory ? `${repo}/tree/main/${options.subdirectory}` : repo
  const name = options.subdirectory ? `${slug}#${options.subdirectory.split('/').pop()}` : slug
  const file = options.subdirectory
    ? `${slug.replace('/', '__')}--${options.subdirectory.replace(/\//g, '-')}.yml`
    : `${slug.replace('/', '__')}.yml`
  const description = typeof pkg.description === 'string' && pkg.description !== ''
    ? pkg.description.replace(/\s+/g, ' ').trim()
    : 'TODO: one line stating what the plugin does.'
  const needsQuoting = description.includes(': ')
  return [
    `# data/plugins/${file}`,
    `url: ${url}`,
    `name: ${name}`,
    `category: ${category}`,
    'description:',
    `  en: ${needsQuoting ? `'${description.replace(/'/g, "''")}'` : description}`,
    '',
  ].join('\n')
}

/**
 * Audit a repository.
 * @param {string} root - repository root to audit.
 * @param {object} [options] - audit options.
 * @param {boolean} [options.strict] - count warnings as failures in `ok`.
 * @param {boolean} [options.network] - allow one GitHub API request for the topic check.
 * @param {string|Date} [options.now] - clock override for the repository-age check.
 * @param {string|null} [options.harnessVersion] - harness version to test peer ranges against.
 * @param {string} [options.dshHome] - DSH home used to detect the harness version.
 * @param {typeof fetch} [options.fetchImpl] - injectable fetch for the topic check.
 * @param {typeof execFileSync} [options.execFileImpl] - injectable process runner for the topic check.
 * @returns {Promise<object>} the audit result: checks, counts, and the overall verdict.
 */
export async function auditRepository(root, options = {}) {
  const absoluteRoot = resolve(root)
  /** @type {Check[]} */
  const checks = []
  const now = options.now instanceof Date ? options.now : options.now ? new Date(options.now) : new Date()

  /** @param {Check} check */
  const push = (check) => checks.push(check)

  const packagePath = join(absoluteRoot, 'package.json')
  const packageRead = existsSync(packagePath) ? readJson(packagePath) : { error: 'package.json does not exist' }
  const pkg = packageRead.value && typeof packageRead.value === 'object'
    ? /** @type {Record<string, unknown>} */ (packageRead.value)
    : null

  if (!pkg) {
    push({
      id: 'manifest.package-json',
      level: 'error',
      status: 'fail',
      title: 'package.json is missing or unparseable',
      detail: packageRead.error ?? 'unknown error',
      fix: 'Add a package.json at the repository root declaring "name", "version", and "dsh.bundle".',
    })
  } else {
    push({
      id: 'manifest.package-json',
      level: 'error',
      status: 'pass',
      title: 'package.json parses',
    })
  }

  const dsh = pkg && typeof pkg.dsh === 'object' && pkg.dsh !== null ? /** @type {Record<string, unknown>} */ (pkg.dsh) : null
  const bundle = dsh && typeof dsh.bundle === 'object' && dsh.bundle !== null ? /** @type {Record<string, unknown>} */ (dsh.bundle) : null
  const patchPath = bundle && typeof bundle.patch === 'string' ? bundle.patch : null

  if (pkg) {
    if (patchPath) {
      push({
        id: 'manifest.bundle',
        level: 'error',
        status: 'pass',
        title: `dsh.bundle.patch is declared (${patchPath})`,
      })
    } else if (dsh && dsh.client) {
      push({
        id: 'manifest.bundle',
        level: 'error',
        status: 'fail',
        title: 'package.json declares dsh.client but not dsh.bundle — this is the most common rejection',
        detail: 'An installable plugin is a bundle: dsh plugin add records the dependency and activates a patch layer. dsh.client alone activates nothing.',
        fix: 'Add "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } and ship that patch file.',
      })
    } else {
      push({
        id: 'manifest.bundle',
        level: 'error',
        status: 'fail',
        title: 'package.json does not declare dsh.bundle',
        detail: 'Without dsh.bundle the package installs as a plain dependency and no layer is activated.',
        fix: 'Add "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } and ship that patch file.',
      })
    }
  } else {
    push({
      id: 'manifest.bundle',
      level: 'error',
      status: 'skip',
      title: 'dsh.bundle could not be checked without a parsed package.json',
    })
  }

  let patchText = null
  if (patchPath) {
    const absolutePatch = isAbsolute(patchPath) ? patchPath : resolve(absoluteRoot, patchPath)
    const inside = !relative(absoluteRoot, absolutePatch).startsWith('..')
    if (!existsSync(absolutePatch) || !statSync(absolutePatch).isFile()) {
      push({
        id: 'manifest.bundle-patch-file',
        level: 'error',
        status: 'fail',
        title: `the declared bundle patch ${patchPath} does not exist`,
        detail: `expected at ${absolutePatch}`,
        fix: 'Create the patch file next to package.json, or point dsh.bundle.patch at the file you ship.',
      })
    } else if (statSync(absolutePatch).size === 0) {
      push({
        id: 'manifest.bundle-patch-file',
        level: 'error',
        status: 'fail',
        title: `the declared bundle patch ${patchPath} is empty`,
        detail: 'An empty patch contributes no plugin row, so installing the bundle changes nothing.',
        fix: 'Give the patch one insert row for the plugin this package ships.',
      })
    } else {
      patchText = readFileSync(absolutePatch, 'utf8')
      push({
        id: 'manifest.bundle-patch-file',
        level: 'error',
        status: 'pass',
        title: `bundle patch ${patchPath} exists`,
      })
      if (!inside) {
        push({
          id: 'manifest.bundle-patch-location',
          level: 'warn',
          status: 'fail',
          title: 'the bundle patch lives outside the repository',
          detail: `${absolutePatch} is not under ${absoluteRoot}, so it is not in the published package.`,
          fix: 'Move the patch into the repository and reference it relatively.',
        })
      }
    }
  } else {
    push({
      id: 'manifest.bundle-patch-file',
      level: 'error',
      status: 'skip',
      title: 'no bundle patch to inspect',
    })
  }

  if (patchText !== null) {
    const scan = scanPatchRows(patchText)
    const name = typeof pkg?.name === 'string' ? pkg.name : null
    if (!scan.isSequence) {
      push({
        id: 'manifest.bundle-patch-rows',
        level: 'error',
        status: 'fail',
        title: 'the bundle patch is not a top-level YAML sequence',
        detail: 'A patch layer is an array of entries such as "- insert:".',
        fix: 'Start the file with "- insert:" and indent the plugin rows under it.',
      })
    } else {
      const rowsWithoutId = scan.rows.filter((row) => row.id === null && !row.keys.includes('insert'))
      const named = scan.rows.filter((row) => row.name !== null)
      const matchesPackage = name !== null && named.some((row) => {
        const rowName = /** @type {string} */ (row.name)
        return rowName === name
          || rowName === name.replace(/^@[^/]+\//, '')
          || rowName.endsWith(`/${name}`)
          || rowName.includes(name)
      })
      if (scan.rows.length === 0) {
        push({
          id: 'manifest.bundle-patch-rows',
          level: 'error',
          status: 'fail',
          title: 'the bundle patch contains no entry rows',
          fix: 'Insert one row naming this package.',
        })
      } else if (named.length === 0) {
        push({
          id: 'manifest.bundle-patch-rows',
          level: 'error',
          status: 'fail',
          title: 'no patch row names a plugin module',
          detail: `rows seen: ${scan.rows.map((row) => row.keys.join('+')).join(', ')}`,
          fix: `Insert a row such as "- id: ${typeof pkg?.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : 'my-plugin'}" with "name: ${name ?? 'my-package'}".`,
        })
      } else if (!matchesPackage) {
        push({
          id: 'manifest.bundle-patch-rows',
          level: 'error',
          status: 'fail',
          title: `no patch row references this package (${name})`,
          detail: `rows name: ${named.map((row) => row.name).join(', ')}`,
          fix: 'A bundle patch row must reference the package by name so Node resolution finds the installed code.',
        })
      } else if (rowsWithoutId.length > 0) {
        push({
          id: 'manifest.bundle-patch-rows',
          level: 'warn',
          status: 'fail',
          title: `${rowsWithoutId.length} plugin row(s) declare no id`,
          detail: 'Rows are id-targeted: later patch layers override them by id.',
          fix: 'Give every plugin row a stable id.',
        })
      } else {
        push({
          id: 'manifest.bundle-patch-rows',
          level: 'error',
          status: 'pass',
          title: `bundle patch has ${scan.rows.length} row(s), including ${named[0].name}`,
        })
      }
    }
  } else {
    push({
      id: 'manifest.bundle-patch-rows',
      level: 'error',
      status: 'skip',
      title: 'no bundle patch to parse',
    })
  }

  if (pkg) {
    const runtime = pkg.dependencies && typeof pkg.dependencies === 'object' ? Object.keys(/** @type {Record<string, unknown>} */ (pkg.dependencies)) : []
    const misplaced = runtime.filter((dependency) => dependency.startsWith('@deepseek-ai/'))
    if (misplaced.length > 0) {
      push({
        id: 'manifest.peer-dependencies',
        level: 'warn',
        status: 'fail',
        title: `${misplaced.length} official @deepseek-ai package(s) are runtime dependencies`,
        detail: misplaced.join(', '),
        fix: 'Declare official @deepseek-ai packages as peerDependencies so the profile supplies one copy.',
      })
    } else {
      push({
        id: 'manifest.peer-dependencies',
        level: 'warn',
        status: 'pass',
        title: 'no official @deepseek-ai package is a runtime dependency',
      })
    }

    const peers = pkg.peerDependencies && typeof pkg.peerDependencies === 'object'
      ? /** @type {Record<string, string>} */ (pkg.peerDependencies)
      : {}
    const harnessVersion = detectHarnessVersion(options)
    const dshPeers = Object.entries(peers).filter(([dependency]) => /^@deepseek-ai\/dsh/.test(dependency))
    const findings = []
    const unparseable = []
    for (const [dependency, range] of dshPeers) {
      const verdict = prereleaseGate(range, harnessVersion)
      if (verdict.status === 'fail') findings.push({ dependency, range, reason: verdict.reason })
      else if (verdict.status === 'unknown') unparseable.push({ dependency, range })
    }
    if (dshPeers.length === 0) {
      push({
        id: 'manifest.peer-prerelease',
        level: 'error',
        status: 'skip',
        title: 'no @deepseek-ai/dsh peer range to test',
        detail: 'A host plugin normally peers on @deepseek-ai/dsh-tools and @deepseek-ai/cordis.',
      })
    } else if (findings.length === 0 && unparseable.length === 0) {
      push({
        id: 'manifest.peer-prerelease',
        level: 'error',
        status: 'pass',
        title: harnessVersion
          ? `${dshPeers.length} harness peer range(s) admit ${harnessVersion}`
          : `${dshPeers.length} harness peer range(s) name a prerelease comparator`,
      })
    } else if (findings.length > 0) {
      const first = findings[0]
      const reasons = {
        'no-prerelease-comparator': 'no comparator in the range carries a prerelease tag, so every prerelease harness build is excluded',
        'no-comparator-on-tuple': `no comparator carries a prerelease tag on the ${harnessVersion} tuple, so node-semver silently excludes it`,
        'comparators-not-satisfied': 'the comparator set does not admit this harness version',
      }
      push({
        id: 'manifest.peer-prerelease',
        level: 'error',
        status: 'fail',
        title: `${findings.length} harness peer range(s) cannot admit ${harnessVersion ?? 'a prerelease harness build'}`,
        detail: findings
          .map((finding) => `${finding.dependency}: "${finding.range}" — ${reasons[finding.reason] ?? finding.reason}`)
          .join('; '),
        fix: 'Add an explicit "||" branch that puts a prerelease tag on the matching tuple, e.g. ">=0.1.1-rc.1 <0.1.2-0".',
      })
    }
    if (unparseable.length > 0) {
      push({
        id: 'manifest.peer-range-parsed',
        level: 'warn',
        status: 'fail',
        title: `${unparseable.length} peer range(s) use syntax this checker does not model`,
        detail: unparseable.map((entry) => `${entry.dependency}: "${entry.range}"`).join('; '),
        fix: 'Test the range against the harness build you target; the checker only models caret, tilde, hyphen, x-ranges, and comparison operators.',
      })
    }
  } else {
    push({ id: 'manifest.peer-dependencies', level: 'warn', status: 'skip', title: 'no parsed package.json' })
    push({ id: 'manifest.peer-prerelease', level: 'error', status: 'skip', title: 'no parsed package.json' })
  }

  const firstCommit = git(absoluteRoot, ['log', '--reverse', '--format=%cI', '-n', '1'])
  if (firstCommit === null || firstCommit === '') {
    push({
      id: 'repo.age',
      level: 'error',
      status: 'skip',
      title: 'repository age could not be read (no git history here)',
      detail: 'The directory is a submission when CI can see at least one commit.',
      fix: 'Commit the work; the directory requires the repository to be at least one day old.',
    })
  } else {
    const first = new Date(firstCommit)
    const ageDays = (now.getTime() - first.getTime()) / DAY_MS
    if (Number.isNaN(ageDays)) {
      push({ id: 'repo.age', level: 'error', status: 'skip', title: `unreadable first-commit date (${firstCommit})` })
    } else if (ageDays < 1) {
      push({
        id: 'repo.age',
        level: 'error',
        status: 'fail',
        title: `repository is ${Math.max(0, ageDays * 24).toFixed(1)}h old; the directory requires at least one day`,
        detail: `first commit ${firstCommit}`,
        fix: 'Finish the work and submit after the repository passes one day of age; resubmission costs nothing.',
      })
    } else {
      push({
        id: 'repo.age',
        level: 'error',
        status: 'pass',
        title: `repository is ${Math.floor(ageDays)} day(s) old`,
      })
    }
  }

  const implementation = pkg ? implementationFiles(absoluteRoot, pkg) : []
  if (!pkg) {
    push({ id: 'repo.implementation', level: 'error', status: 'skip', title: 'no parsed package.json' })
  } else if (implementation.length === 0) {
    push({
      id: 'repo.implementation',
      level: 'error',
      status: 'fail',
      title: 'no implementation file found',
      detail: 'Placeholder, name-squat, and README-only repositories are rejected.',
      fix: 'Ship working code and reference it from "main", "bin", or "exports".',
    })
  } else {
    push({
      id: 'repo.implementation',
      level: 'error',
      status: 'pass',
      title: `${implementation.length} implementation file(s), e.g. ${implementation[0]}`,
    })
  }

  if (pkg && patchPath && implementation.length === 0) {
    push({
      id: 'packaging.meta-bundle',
      level: 'warn',
      status: 'fail',
      title: 'this bundle ships a patch but no behaviour of its own',
      detail: 'A bundle whose only content is a dependency list is not listed; list the plugins, not the bundle.',
      fix: 'Give the bundle its own code, or list the individual plugins instead.',
    })
  } else if (pkg) {
    push({ id: 'packaging.meta-bundle', level: 'warn', status: 'pass', title: 'the bundle ships code of its own' })
  }

  if (pkg) {
    const description = typeof pkg.description === 'string' ? pkg.description.trim() : ''
    const marketing = MARKETING_TERMS.filter((term) => description.toLowerCase().includes(term))
    if (description === '') {
      push({
        id: 'description.substance',
        level: 'error',
        status: 'fail',
        title: 'package.json has no description',
        detail: 'The directory shows the description and reads it as a claim about the plugin.',
        fix: 'State what the plugin does in one line.',
      })
    } else {
      push({ id: 'description.substance', level: 'error', status: 'pass', title: 'package.json has a description' })
    }
    if (marketing.length > 0) {
      push({
        id: 'description.marketing',
        level: 'warn',
        status: 'fail',
        title: `description uses marketing language (${marketing.map((term) => term.trim()).join(', ')})`,
        fix: 'Descriptions state what the plugin does; every claim is checked against the code.',
      })
    } else if (description !== '') {
      push({ id: 'description.marketing', level: 'warn', status: 'pass', title: 'description states what the plugin does' })
    }

    const repository = typeof pkg.repository === 'string'
      ? pkg.repository
      : pkg.repository && typeof pkg.repository === 'object' && typeof /** @type {Record<string, unknown>} */ (pkg.repository).url === 'string'
        ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (pkg.repository).url)
        : ''
    const slug = remoteSlug(absoluteRoot)
    if (repository === '') {
      push({
        id: 'packaging.repository',
        level: 'warn',
        status: 'fail',
        title: 'package.json declares no repository',
        fix: 'Publish to npm and point "repository" at the listed repository, or the package will not link to its entry.',
      })
    } else if (slug !== null && !repository.includes(slug)) {
      push({
        id: 'packaging.repository',
        level: 'warn',
        status: 'fail',
        title: 'the repository field does not point at this repository',
        detail: `"${repository}" does not contain ${slug}`,
        fix: `Point "repository" at https://github.com/${slug}.`,
      })
    } else {
      push({ id: 'packaging.repository', level: 'warn', status: 'pass', title: 'package.json declares its repository' })
    }
  } else {
    push({ id: 'description.substance', level: 'error', status: 'skip', title: 'no parsed package.json' })
  }

  const slug = remoteSlug(absoluteRoot)
  if (!options.network) {
    push({
      id: 'repo.topic',
      level: 'error',
      status: 'skip',
      title: 'the dsh-plugin GitHub topic was not checked (offline)',
      detail: slug ? `repository: ${slug}` : 'no GitHub origin remote was found',
      fix: `Re-run with --network, or add the topic yourself: gh api -X PUT repos/${slug ?? 'owner/repo'}/topics -f names[]=dsh-plugin`,
    })
  } else if (slug === null) {
    push({
      id: 'repo.topic',
      level: 'error',
      status: 'fail',
      title: 'no GitHub origin remote, so the topic cannot be checked',
      fix: 'Push the repository to GitHub and add the dsh-plugin topic.',
    })
  } else {
    const result = await fetchTopics(slug, { fetchImpl: options.fetchImpl, execFileImpl: options.execFileImpl })
    if ('error' in result) {
      push({
        id: 'repo.topic',
        level: 'error',
        status: 'skip',
        title: `the dsh-plugin topic could not be read for ${slug}`,
        detail: result.error,
        fix: `Check it directly: gh api repos/${slug} --jq .topics`,
      })
    } else if (result.topics.includes('dsh-plugin')) {
      push({ id: 'repo.topic', level: 'error', status: 'pass', title: `${slug} carries the dsh-plugin topic` })
    } else {
      push({
        id: 'repo.topic',
        level: 'error',
        status: 'fail',
        title: `${slug} does not carry the dsh-plugin topic`,
        detail: result.topics.length > 0 ? `topics: ${result.topics.join(', ')}` : 'the repository has no topics',
        fix: `gh api -X PUT repos/${slug}/topics -f names[]=dsh-plugin`,
      })
    }
  }

  const errors = checks.filter((check) => check.status === 'fail' && check.level === 'error').length
  const warnings = checks.filter((check) => check.status === 'fail' && check.level === 'warn').length
  const skipped = checks.filter((check) => check.status === 'skip').length
  const passed = checks.filter((check) => check.status === 'pass').length
  return {
    root: absoluteRoot,
    slug,
    harnessVersion: pkg ? detectHarnessVersion(options) : null,
    checks,
    errors,
    warnings,
    skipped,
    passed,
    ok: errors === 0 && (!options.strict || warnings === 0),
  }
}

export { CATEGORIES }
