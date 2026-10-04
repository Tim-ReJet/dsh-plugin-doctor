#!/usr/bin/env node
/**
 * `dsh-plugin-doctor` — audit a repository against the dsh-plugin listing rules, from the shell.
 * The plugin's `plugin_doctor` tool runs the same engine.
 * @module dsh-plugin-doctor/cli
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { auditRepository, emitEntry, remoteSlug, CATEGORIES } from '../src/audit.js'
import { formatReport } from '../src/report.js'

const USAGE = `dsh-plugin-doctor — check a repository against the dsh-plugin listing rules

Usage
  dsh-plugin-doctor [path] [options]

Options
  --strict                     count warnings as failures too
  --network                    verify the dsh-plugin GitHub topic (one GitHub API request)
  --harness-version <version>  harness build to test @deepseek-ai/dsh peer ranges against
  --now <iso-date>             clock override for the repository-age check
  --json                       print the result as JSON
  --verbose                    list passing checks as well
  --emit-entry                 print the awesome-dsh-plugin catalog entry for this repository
  --category <category>        category for --emit-entry (default dev)
  --subdirectory <path>        monorepo subpackage for --emit-entry
  -h, --help                   print this help

Categories
  ${CATEGORIES.join(', ')}

Exit status
  0 when no error-level check fails, 1 when one does, 2 on a usage error.

The audit is read-only: it never writes to the repository. It reads git history for the
repository-age check, and touches the network only with --network.`

/**
 * Parse argv into options.
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {{help?: boolean, error?: string, path?: string, strict?: boolean, network?: boolean,
 *   harnessVersion?: string, now?: string, json?: boolean, verbose?: boolean, emitEntry?: boolean,
 *   category?: string, subdirectory?: string}} parsed options.
 */
export function parseArgs(argv) {
  const options = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const takeValue = (flag) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      index += 1
      return value
    }
    try {
      if (arg === '-h' || arg === '--help') options.help = true
      else if (arg === '--strict') options.strict = true
      else if (arg === '--network') options.network = true
      else if (arg === '--json') options.json = true
      else if (arg === '--verbose') options.verbose = true
      else if (arg === '--emit-entry') options.emitEntry = true
      else if (arg === '--harness-version') options.harnessVersion = takeValue('--harness-version')
      else if (arg === '--now') options.now = takeValue('--now')
      else if (arg === '--category') options.category = takeValue('--category')
      else if (arg === '--subdirectory') options.subdirectory = takeValue('--subdirectory')
      else if (arg.startsWith('-')) return { error: `unknown option ${arg}` }
      else positional.push(arg)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  if (positional.length > 1) return { error: `expected at most one path, got ${positional.length}` }
  if (positional.length === 1) options.path = positional[0]
  if (options.category !== undefined && !CATEGORIES.includes(options.category)) {
    return { error: `unknown category ${options.category}` }
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.error) {
    process.stderr.write(`dsh-plugin-doctor: ${options.error}\n\n${USAGE}\n`)
    process.exit(2)
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }

  const root = resolve(options.path ?? '.')
  if (options.emitEntry) {
    const packagePath = join(root, 'package.json')
    if (!existsSync(packagePath)) {
      process.stderr.write(`dsh-plugin-doctor: no package.json under ${root}\n`)
      process.exit(2)
    }
    let pkg
    try {
      pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
    } catch (error) {
      process.stderr.write(`dsh-plugin-doctor: cannot parse ${packagePath}: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(2)
    }
    const { remoteSlug } = await import('../src/audit.js')
    const slug = remoteSlug(root)
    if (slug === null) {
      process.stderr.write('dsh-plugin-doctor: no GitHub origin remote, so the entry url cannot be built\n')
      process.exit(2)
    }
    process.stdout.write(emitEntry(pkg, slug, {
      ...(options.category ? { category: options.category } : {}),
      ...(options.subdirectory ? { subdirectory: options.subdirectory } : {}),
    }))
    process.exit(0)
  }

  const result = await auditRepository(root, {
    strict: options.strict === true,
    network: options.network === true,
    harnessVersion: options.harnessVersion ?? null,
    ...(options.now ? { now: options.now } : {}),
  })

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatReport(result, { verbose: options.verbose === true })}\n`)
  }
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`dsh-plugin-doctor: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(2)
})
