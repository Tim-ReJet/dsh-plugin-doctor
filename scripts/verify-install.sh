#!/usr/bin/env bash
# Walk the install path a user takes: fetch this repository from GitHub into a throwaway DSH home,
# install it into a throwaway profile, and confirm the bundle layer composed. Network is required;
# no model call and no credentials are involved. The temporary home is removed on exit.
#
# Usage: npm run verify:install [-- <git-spec>]

set -euo pipefail

spec="${1:-github:Tim-ReJet/dsh-plugin-doctor}"
home="$(mktemp -d "${TMPDIR:-/tmp}/dsh-doctor-install.XXXXXX")"
trap 'rm -rf "$home"' EXIT

echo "installing $spec into a throwaway profile under $home"
DSH_HOME="$home" dsh plugin --profile verify add "$spec" >/dev/null
if ! DSH_HOME="$home" dsh --profile verify --dump-config | grep -q 'id: plugin-doctor'; then
  echo "FAIL: the bundle layer did not compose" >&2
  exit 1
fi
echo "OK: the installed bundle contributed its plugin-doctor row"
