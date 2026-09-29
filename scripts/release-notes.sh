#!/usr/bin/env bash
# The text of a release page: what CHANGELOG.md says about a version between its
# "## [X.Y.Z]" heading and the first "###" heading under it — the summary. The
# detailed lists below it stay in the changelog.
#
#   scripts/release-notes.sh 0.2.0 [CHANGELOG.md]
#
# Exits non-zero, saying why on stderr, when the changelog has no section for
# the version or its summary is empty. The image workflow checks this before it
# builds anything, and uses the text for the release page.
set -euo pipefail

version=${1:?usage: release-notes.sh <version> [changelog]}
changelog=${2:-"$(dirname "$0")/../CHANGELOG.md"}

if ! grep -qF "## [$version]" "$changelog"; then
  echo "$changelog has no section '## [$version]'." >&2
  exit 1
fi

notes=$(awk -v version="$version" '
  /^## \[/ { if (found) exit; found = index($0, "[" version "]") > 0; next }
  found && /^### / { exit }
  found { print }
' "$changelog")

if ! printf '%s' "$notes" | grep -q '[^[:space:]]'; then
  echo "$changelog has no summary for $version (the text between its '## [$version]' line and the first '###' line)." >&2
  exit 1
fi

printf '%s\n' "$notes"
