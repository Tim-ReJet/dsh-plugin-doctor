/**
 * The Cordis plugin: one host row that registers the read-only `plugin_doctor` tool.
 * @module dsh-plugin-doctor
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { auditRepository } from './audit.js'
import { formatReport } from './report.js'

export const name = 'plugin-doctor'
export const inject = ['tools']

/** Configuration for the plugin row; every field also has a per-call default. */
export const Config = z.object({
  strict: z.boolean().default(false),
  network: z.boolean().default(false),
  path: z.string().default('.'),
})

const DEFAULTS = { strict: false, network: false, path: '.' }

const DESCRIPTION = [
  'Audit a repository against the mechanical rules that decide whether a DeepSeek Harness plugin',
  'can be listed in the dsh-plugin directory: a dsh.bundle patch manifest, a parseable bundle',
  'patch that names the package, prerelease-safe @deepseek-ai/dsh peer ranges, real implementation',
  'code, a repository at least a day old, a description without marketing language, and the',
  'dsh-plugin GitHub topic. Read-only: it writes nothing, and it makes no network request unless',
  'network is true (which reads the repository topics from GitHub).',
].join(' ')

/**
 * Register `plugin_doctor` on `ctx.tools`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the Cordis context.
 * @param {{strict?: boolean, network?: boolean, path?: string}} [config] - the row configuration.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  ctx.tools.register(defineTool({
    name: 'plugin_doctor',
    description: DESCRIPTION,
    parameters: {
      path: {
        type: 'string',
        description: 'Repository root to audit. Defaults to the plugin config path, then the working directory.',
      },
      strict: {
        type: 'boolean',
        description: 'Count warnings as failures in the returned ok flag. Defaults to the plugin config.',
      },
      network: {
        type: 'boolean',
        description: 'Also verify the dsh-plugin GitHub topic (one GitHub API request). Defaults to the plugin config.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          errors: { type: 'integer', required: true },
          warnings: { type: 'integer', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const result = await auditRepository(args.path ?? settings.path, {
        strict: args.strict ?? settings.strict,
        network: args.network ?? settings.network,
      })
      return {
        ok: result.ok,
        errors: result.errors,
        warnings: result.warnings,
        report: formatReport(result),
      }
    },
  }))
}
