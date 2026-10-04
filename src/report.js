/**
 * Human-readable rendering of an audit result, shared by the CLI and the `plugin_doctor` tool so
 * both tell the same story.
 * @module dsh-plugin-doctor/report
 */

/** @type {Record<string, string>} */
const MARK = { pass: 'ok  ', fail: 'FAIL', skip: 'skip' }

/**
 * Format an audit result as a report.
 * @param {object} result - the value returned by `auditRepository`.
 * @param {{verbose?: boolean}} [options] - `verbose` lists passing checks too.
 * @returns {string} the report text.
 */
export function formatReport(result, options = {}) {
  const lines = []
  lines.push(`dsh-plugin-doctor · ${result.root}`)
  lines.push(`${result.passed} passed · ${result.errors} error${result.errors === 1 ? '' : 's'} · ${result.warnings} warning${result.warnings === 1 ? '' : 's'} · ${result.skipped} skipped`)
  const interesting = result.checks.filter((check) => check.status !== 'pass')
  const shown = options.verbose ? result.checks : interesting
  if (shown.length > 0) lines.push('')
  for (const check of shown) {
    lines.push(`${MARK[check.status]} ${check.id} — ${check.title}`)
    if (check.detail) lines.push(`     ${check.detail}`)
    if (check.fix && check.status !== 'pass') lines.push(`     fix: ${check.fix}`)
  }
  if (interesting.length === 0) {
    lines.push('')
    lines.push('No blocking finding. Whether the plugin does what its description says is still a human read.')
  }
  return lines.join('\n')
}
