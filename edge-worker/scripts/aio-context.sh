#!/usr/bin/env sh
#
# Switch (or snapshot) the active AEM Edge Functions deploy target.
#
# `aio aem edge-functions deploy` has no --program flag: it deploys to whatever
# Cloud Manager org/program is recorded in the local `.aio` context file. This
# repo is repoless/multi-site (one code base fronts several sites, each its own
# Cloud Manager program), so deploying to a given site means pointing `.aio` at
# that site's context first. We keep one committed template per site (`.aio.<name>`)
# and copy the chosen one into place before building + deploying.
#
# Usage:
#   scripts/aio-context.sh use  <name>   # copy .aio.<name> -> .aio  (pick a target)
#   scripts/aio-context.sh save <name>   # copy .aio -> .aio.<name>  (snapshot current)
#
# Typical: `npm run deploy:red` / `npm run deploy:writing` call `use` for you.
# To onboard a new site: run `aio aem edge-functions setup`, then
# `npm run context:save -- <name>` to capture it as a reusable template.

set -e

cmd="$1"
name="$2"

if [ -z "$name" ]; then
  echo "usage: $0 use|save <name>" >&2
  echo "available contexts:" >&2
  ls .aio.* 2>/dev/null | sed 's/^\.aio\./  /' >&2 || echo "  (none)" >&2
  exit 1
fi

case "$cmd" in
  use)
    if [ ! -f ".aio.$name" ]; then
      echo "No context '.aio.$name'." >&2
      echo "Create it with: aio aem edge-functions setup && npm run context:save -- $name" >&2
      exit 1
    fi
    cp ".aio.$name" .aio
    echo "Active AEM Edge Functions context -> $name"
    ;;
  save)
    if [ ! -f .aio ]; then
      echo "No .aio to save. Run 'aio aem edge-functions setup' first." >&2
      exit 1
    fi
    cp .aio ".aio.$name"
    echo "Saved current .aio -> .aio.$name"
    ;;
  *)
    echo "usage: $0 use|save <name>" >&2
    exit 1
    ;;
esac
