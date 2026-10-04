# dsh-plugin-doctor

A DeepSeek Harness host plugin and CLI that audits a repository against the mechanical rules the
[`dsh-plugin` directory](https://github.com/topics/dsh-plugin) enforces on a submission — the rules
that a repository can satisfy silently, or fail silently, long before a maintainer reads it.

It registers one model-facing tool, `plugin_doctor`, and ships the same engine as a CLI. Both are
read-only: nothing is written to the audited repository, and no network request is made unless
`network` is true.

## What it checks

Up to fifteen checks run. Which ones depends on what the repository declares — a repository with
no parseable manifest runs fewer — and two run only when their condition exists (a patch outside the
package directory, a peer range this checker cannot model).

| Check id | Fails as | What it reads |
| --- | --- | --- |
| `manifest.package-json` | error | the manifest exists and parses — the root package.json, or a subpackage that declares `dsh.bundle` |
| `manifest.bundle` | error | `dsh.bundle.patch` is declared — a package declaring only `dsh.client` installs nothing installable |
| `manifest.bundle-patch-file` | error | the declared patch file exists, is a file, is non-empty |
| `manifest.bundle-patch-location` *(conditional)* | warn | the patch is inside the package directory, so it ships in the package |
| `manifest.bundle-patch-rows` | error | the patch is a top-level YAML sequence whose rows are id/name pairs and at least one row names this package |
| `manifest.peer-dependencies` | warn | no official `@deepseek-ai/*` package sits in `dependencies` instead of `peerDependencies` |
| `manifest.peer-prerelease` | error | every `@deepseek-ai/dsh*` peer range admits the harness build in use, prerelease gate included; with no detectable harness version it falls back to a structural check and says so |
| `manifest.peer-range-parsed` *(conditional)* | warn | a peer range uses syntax this checker does not model (it says so instead of guessing) |
| `repo.age` | error | the oldest root commit is at least one day old, read from git history |
| `repo.implementation` | error | implementation files exist in the manifest directory, reached through `main`, `bin`, `exports`, `files`, or a `src`/`lib`/`index.*` fallback |
| `packaging.meta-bundle` | warn | the bundle ships a patch *and* behaviour of its own; a dependency list alone is not listed |
| `description.substance` | error | `package.json` carries a description |
| `description.marketing` | error | the description states what the plugin does rather than praising it (word-list heuristic) |
| `packaging.repository` | warn | `repository` is declared and points at this repository, or says it cannot be confirmed without an origin remote |
| `repo.topic` | error | the GitHub repository carries the `dsh-plugin` topic (needs `--network`, otherwise reported as skipped) |

Every failure names the concrete fix. The CLI exits 0 when no check fails (and, under `--strict`, no
warning fails), 1 when one does, and 2 on a usage error.

## Install

Into a profile, once published to npm:

```sh
dsh plugin --profile web add dsh-plugin-doctor
```

From this repository, before any npm release:

```sh
dsh plugin --profile web add github:Tim-ReJet/dsh-plugin-doctor
```

Both append the bundle layer to that profile's `dsh.profile.bundles`; the layer inserts one host row
named `plugin-doctor`. Confirm the layer composed:

```sh
dsh --profile web --dump-config | grep -A 3 plugin-doctor
```

For local development against a source checkout, skip the install and load the entry point with a
patch overlay:

```yaml
# doctor.overlay.yml
- insert:
    - id: plugin-doctor
      name: '/absolute/path/to/dsh-plugin-doctor/src/index.js'
      config:
        path: '/absolute/path/to/the/repository/you/are/auditing'
```

```sh
dsh --profile web --patch ./doctor.overlay.yml
```

## Use

The tool, from any session where the plugin is composed:

> Run `plugin_doctor` on this repository and fix what it reports.

It returns `ok`, `errors`, `warnings`, and a `report`. Its `path`, `strict`, and `network`
parameters default to the row configuration in `cordis.patch.yml`.

The CLI, from a checkout — no install required:

```sh
node bin/dsh-plugin-doctor.mjs [path]
```

| Flag | Effect |
| --- | --- |
| `--strict` | count warnings as failures in the exit status |
| `--network` | verify the `dsh-plugin` GitHub topic (a GitHub request, via `gh` or `GH_TOKEN`) |
| `--harness-version <version>` | test peer ranges against this harness build instead of detecting one |
| `--now <iso-date>` | clock override for the repository-age check (testing aid) |
| `--json` | print the whole result as JSON |
| `--verbose` | list passing checks too |
| `--emit-entry` | print the `data/plugins/<owner>__<repo>.yml` entry the directory would want |

`--emit-entry` always single-quotes and escapes the description, because a bare scalar breaks on a
colon, on ` #` (silently truncating it) and on a leading YAML indicator such as `@`. In a monorepo it
points the entry at the subpackage that declares `dsh.bundle`.

## The prerelease trap this exists for

An installable plugin peers on the harness packages. Almost every range that looks right is wrong
for a prerelease harness, because node-semver admits a prerelease version only when some comparator
in the matching branch carries a prerelease tag on the *same* `major.minor.patch` tuple:

```jsonc
// looks broad, silently excludes every 0.1.1-* and 0.2.0-* build
"@deepseek-ai/dsh-tools": ">=0.1.0-rc.1 <0.3.0-0"
"@deepseek-ai/dsh-tools": "*"

// admitted: the branch names the tuple with a prerelease tag
"@deepseek-ai/dsh-tools": ">=0.1.1-rc.1 <0.1.2-0 || >=0.2.0-rc.1 <0.2.1-0"
```

`manifest.peer-prerelease` reports which of the two failures applies. The checker is not a semver
implementation: it models caret, tilde, hyphen, x-ranges, and comparison operators, and its expected
answers are pinned to what node-semver itself answered for 450 recorded (range, version) pairs in
[`tests/fixtures/node-semver-table.json`](tests/fixtures/node-semver-table.json). Anything it cannot
parse is reported as `manifest.peer-range-parsed` instead of being guessed at.

## What it cannot check

- **Whether the plugin does what its description says.** That is what a maintainer reads the source
  for, and no checker replaces it. Do not treat a clean run as that review.
- **Security.** Being listed is not a security review, and neither is this. The audit reads
  manifests and structure, not behaviour.
- **The rest of the submission surface**: the entry file beyond what `--emit-entry` prints,
  `screenshots.json` rules, tarball hosting rules, and whether a bundle's dependencies point at the
  original author's repository rather than a re-upload.
- **Whether the code is real rather than a stub.** A file that exports nothing still counts as an
  implementation file here.
- **Whether the category fits**, or whether the plugin duplicates an existing entry.
- **Whether the project is actively maintained.** The directory's periodic scan flags repositories
  that are gone, archived, or long dormant; this audit reads one moment in time.
- **npm publication and download counts.** Listing does not depend on them.

## Verification

- `npm test` runs 40 tests on `node:test` with no network: fixtures are throwaway repositories in the
  temp directory, and the prerelease gate is checked against the recorded node-semver table. The
  package declares no `dependencies` — the audit engine and CLI need none; the host plugin needs its
  declared peers, and the four host-plugin tests skip when those peers are not resolvable.
- The repository audits itself to zero errors apart from `repo.age`, which fails until the repository
  is a day old — the directory's own rule. `npm run doctor` therefore exits 1 today and 0 tomorrow; a
  test covers the same run with the clock moved past the gate.
- End to end, in a real harness with the plugin composed and a model calling the tool: verified on
  harness `0.1.1-rc.2` and `0.2.0-rc.2`, the two lines its peer range names.
- The install path was walked by hand on 2026-10-04 and is reproducible with `npm run verify:install`
  (network required): it installs `github:Tim-ReJet/dsh-plugin-doctor` into a throwaway profile,
  checks the bundle layer composed, and removes the profile. No automated test covers it.

## Peer dependencies

`@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` are `peerDependencies`, so the profile
supplies one copy each; `@deepseek-ai/cordis` is a stable 4.x line and is declared `^4.0.1`. The
harness range names an explicit prerelease branch per tuple, as the directory requires.

## Getting listed

The directory is [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin);
[`contributing.md`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
is the contract this plugin checks. Listing takes one file in a pull request —
`data/plugins/<owner>__<repo>.yml`, which `--emit-entry` prints — plus the `dsh-plugin` topic on the
repository and a repository at least a day old.

`dshmarket` installs only sources named in that curated registry, so carrying the topic alone makes a
repository discoverable under the topic, not installable from the market.

## License

MIT
