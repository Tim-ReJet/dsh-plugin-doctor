/**
 * The node-semver subset this plugin needs to decide one question: does a peer range admit a
 * prerelease harness build? node-semver only lets a prerelease version satisfy a comparator set
 * when some comparator in that set carries a prerelease tag on the *same* `major.minor.patch`
 * tuple. A range that looks broad (`>=0.1.0-rc.1 <0.3.0-0`, `*`) therefore silently excludes
 * `0.1.1-rc.2`. That is the failure mode this module reproduces precisely enough to name it.
 * @module dsh-plugin-doctor/semver-gate
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parse a full version string.
 * @param {string} text - candidate version, optionally v-prefixed and build-tagged.
 * @returns {{major: number, minor: number, patch: number, prerelease: string[], raw: string}|null}
 *   the parsed version, or null when it is not a full `x.y.z` version.
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = VERSION_RE.exec(text.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    raw: text.trim(),
  }
}

/**
 * Compare two parsed versions with node-semver ordering: numeric fields first, then prerelease
 * identifiers, where a release outranks its prereleases and numeric identifiers rank below
 * alphanumeric ones.
 * @param {ReturnType<typeof parseVersion>} a - left version.
 * @param {ReturnType<typeof parseVersion>} b - right version.
 * @returns {number} negative when a &lt; b, positive when a &gt; b, zero when equal.
 */
export function compareVersions(a, b) {
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1
  }
  const left = a.prerelease
  const right = b.prerelease
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const x = left[index]
    const y = right[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
      continue
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * Whether two versions share the `major.minor.patch` tuple that gates prerelease admission.
 * @param {ReturnType<typeof parseVersion>} a - left version.
 * @param {ReturnType<typeof parseVersion>} b - right version.
 * @returns {boolean} true when the tuples are identical.
 */
export function sameTuple(a, b) {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch
}

/** @param {number} major @param {number} minor @param {number} patch */
function version(major, minor, patch) {
  return { major, minor, patch, prerelease: [], raw: `${major}.${minor}.${patch}` }
}

/**
 * The `<next>-0` upper bound node-semver uses so prereleases of the next tuple stay out. It is
 * marked synthetic: the `-0` is machinery, not a prerelease the author wrote, so it must never
 * count as the comparator that admits prerelease builds.
 */
function upperBound(major, minor, patch) {
  return { major, minor, patch, prerelease: ['0'], raw: `${major}.${minor}.${patch}-0`, synthetic: true }
}

/**
 * Whether a comparator was authored with a prerelease tag, as opposed to carrying the synthetic
 * `-0` that range expansion adds.
 * @param {{op: string, version: ReturnType<typeof parseVersion>|null}} comparator - one comparator.
 * @returns {boolean} true when the author wrote a prerelease tag on this comparator.
 */
function authoredPrerelease(comparator) {
  return comparator.version !== null
    && comparator.version.prerelease.length > 0
    && comparator.version.synthetic !== true
}

/**
 * Expand one whitespace-free range token into comparators. Partial versions (`0.1`, `0.1.x`,
 * `1`) follow node-semver's x-range rules; `^` and `~` expand against the lowest specified field.
 * @param {string} token - one comparator such as `>=0.1.1-rc.1`, `^4.0.1`, or `0.1.x`.
 * @returns {{op: string, version: ReturnType<typeof parseVersion>|null}[]|null} comparators, or
 *   null when the token cannot be parsed.
 */
function expandToken(token) {
  const raw = token.trim()
  if (raw === '' || raw === '*' || raw === 'x' || raw === 'X') return [{ op: '*', version: null }]

  const operatorMatch = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(raw)
  if (!operatorMatch) return null
  const [, operator = '', rest] = operatorMatch
  const partial = PARTIAL_RE.exec(rest)
  if (!partial) return null

  const [, majorText, minorText, patchText, prereleaseText] = partial
  const wildcard = (value) => value === undefined || value === 'x' || value === 'X' || value === '*'
  const major = wildcard(majorText) ? null : Number(majorText)
  const minor = wildcard(minorText) ? null : Number(minorText)
  const patch = wildcard(patchText) ? null : Number(patchText)
  const prerelease = prereleaseText ? prereleaseText.split('.') : []

  if (major === null) return [{ op: '*', version: null }]

  const lower = (m, mi, p) => ({ major: m, minor: mi, patch: p, prerelease, raw: rest })

  if (operator === '^') {
    const base = lower(major, minor ?? 0, patch ?? 0)
    if (major > 0) return [{ op: '>=', version: base }, { op: '<', version: upperBound(major + 1, 0, 0) }]
    // Below 1.0.0 caret pins the first non-zero field: ^0.x allows any 0.x, ^0.0.x allows 0.0.x,
    // ^0.0.3 allows 0.0.3 only (up to 0.0.4-0).
    if (minor === null) return [{ op: '>=', version: base }, { op: '<', version: upperBound(1, 0, 0) }]
    if (minor > 0 || patch === null) return [{ op: '>=', version: base }, { op: '<', version: upperBound(0, minor + 1, 0) }]
    return [{ op: '>=', version: base }, { op: '<', version: upperBound(0, 0, patch + 1) }]
  }

  if (operator === '~') {
    const base = lower(major, minor ?? 0, patch ?? 0)
    if (minor === null) return [{ op: '>=', version: base }, { op: '<', version: upperBound(major + 1, 0, 0) }]
    return [{ op: '>=', version: base }, { op: '<', version: upperBound(major, minor + 1, 0) }]
  }

  if (operator === '') {
    if (minor === null) {
      return [{ op: '>=', version: lower(major, 0, 0) }, { op: '<', version: upperBound(major + 1, 0, 0) }]
    }
    if (patch === null) {
      return [{ op: '>=', version: lower(major, minor, 0) }, { op: '<', version: upperBound(major, minor + 1, 0) }]
    }
    return [{ op: '=', version: lower(major, minor, patch) }]
  }

  if (minor === null || patch === null) {
    // `>=0.1` and friends: a missing field is an x-range for `=` and the lowest value otherwise.
    const base = lower(major, minor ?? 0, patch ?? 0)
    const next = minor === null ? upperBound(major + 1, 0, 0) : upperBound(major, minor + 1, 0)
    if (operator === '>=') return [{ op: '>=', version: base }]
    if (operator === '>') return [{ op: '>=', version: next }]
    if (operator === '<') return [{ op: '<', version: base }]
    if (operator === '<=') return [{ op: '<', version: next }]
    return [{ op: '>=', version: base }, { op: '<', version: next }]
  }

  return [{ op: operator, version: lower(major, minor, patch) }]
}

/**
 * Parse an OR-of-AND comparator range into its branches, expanding caret, tilde, hyphen, and
 * x-ranges the way node-semver does.
 * @param {string} range - a semver range such as `^4.0.1` or `a || b`.
 * @returns {{op: string, version: ReturnType<typeof parseVersion>|null}[][]|null} branches, or
 *   null when any part of the range cannot be parsed.
 */
export function parseRange(range) {
  if (typeof range !== 'string' || range.trim() === '') return null
  // `>= 0.1.1-rc.1 < 0.1.2-0` is valid node-semver: the operator and its version may be separated
  // by whitespace, which would otherwise look like a bare operator token.
  const normalised = range.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
  const branches = []
  for (const branch of normalised.split('||')) {
    const trimmed = branch.trim()
    if (trimmed === '') return null
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed)
    if (hyphen) {
      const from = parseVersion(hyphen[1])
      const to = parseVersion(hyphen[2])
      if (!from || !to) return null
      branches.push([{ op: '>=', version: from }, { op: '<=', version: to }])
      continue
    }
    const comparators = []
    for (const token of trimmed.split(/\s+/)) {
      const expanded = expandToken(token)
      if (!expanded) return null
      comparators.push(...expanded)
    }
    if (comparators.length === 0) return null
    branches.push(comparators)
  }
  return branches.length > 0 ? branches : null
}

/** @param {{op: string, version: ReturnType<typeof parseVersion>|null}} comparator */
function comparatorHolds(comparator, candidate) {
  if (comparator.op === '*') return true
  const comparison = compareVersions(candidate, comparator.version)
  switch (comparator.op) {
    case '>=': return comparison >= 0
    case '>': return comparison > 0
    case '<': return comparison < 0
    case '<=': return comparison <= 0
    case '=': return comparison === 0
    default: return false
  }
}

/**
 * Whether a version satisfies a parsed range, applying node-semver's prerelease gate.
 * @param {ReturnType<typeof parseRange>} branches - parsed range branches.
 * @param {ReturnType<typeof parseVersion>} candidate - the version to test.
 * @returns {boolean} true when at least one branch admits the version.
 */
export function satisfiesParsedRange(branches, candidate) {
  return branches.some((branch) => {
    if (!branch.every((comparator) => comparatorHolds(comparator, candidate))) return false
    if (candidate.prerelease.length === 0) return true
    return branch.some((comparator) => authoredPrerelease(comparator)
      && sameTuple(comparator.version, candidate))
  })
}

/**
 * Whether a version satisfies a range, including the prerelease gate.
 * @param {string} range - semver range.
 * @param {string} candidate - version to test.
 * @returns {boolean|null} true/false, or null when the range or version cannot be parsed.
 */
export function satisfies(range, candidate) {
  const branches = parseRange(range)
  const parsed = parseVersion(candidate)
  if (!branches || !parsed) return null
  return satisfiesParsedRange(branches, parsed)
}

/**
 * Decide whether a peer range admits a given harness build.
 * @param {string} range - the declared peer range.
 * @param {string|null} harnessVersion - the harness version in use, when known.
 * @returns {{status: 'ok'|'fail'|'unknown', reason?: string, note?: string}} the verdict;
 *   `reason` is `no-prerelease-comparator`, `no-comparator-on-tuple`, or `comparators-not-satisfied`.
 */
export function prereleaseGate(range, harnessVersion) {
  const branches = parseRange(range)
  if (!branches) return { status: 'unknown', reason: 'unparseable-range' }

  const hasPrereleaseComparator = branches.some((branch) => branch.some(authoredPrerelease))

  if (harnessVersion === null || harnessVersion === undefined) {
    return hasPrereleaseComparator
      ? { status: 'ok', note: 'structural check only: the range names a prerelease comparator' }
      : { status: 'fail', reason: 'no-prerelease-comparator' }
  }

  const candidate = parseVersion(harnessVersion)
  if (!candidate) return { status: 'unknown', reason: 'unparseable-version' }
  if (candidate.prerelease.length === 0) {
    // A release harness is exempt from the prerelease gate, but the comparators must still admit it.
    return satisfiesParsedRange(branches, candidate)
      ? { status: 'ok', note: `harness ${candidate.raw} is a release and the range admits it` }
      : { status: 'fail', reason: 'comparators-not-satisfied' }
  }
  if (satisfiesParsedRange(branches, candidate)) return { status: 'ok' }
  if (!hasPrereleaseComparator) return { status: 'fail', reason: 'no-prerelease-comparator' }
  const tuplePresent = branches.some((branch) => branch.some((comparator) =>
    authoredPrerelease(comparator) && sameTuple(comparator.version, candidate)))
  return { status: 'fail', reason: tuplePresent ? 'comparators-not-satisfied' : 'no-comparator-on-tuple' }
}
