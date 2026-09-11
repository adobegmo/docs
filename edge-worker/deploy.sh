#!/usr/bin/env bash
#
# Deploy the docket-auth edge function to a NAMED target program.
#
# The worker runs in more than one Cloud Manager program (one per gated site
# family). `aio aem edge-functions deploy` has no --programId flag: it deploys to
# whatever the aio context (.aio) points at. That makes it dangerously easy to
# build one site and deploy it over another. This wrapper resolves the target
# from deploy-targets.json and rewrites .aio explicitly before every build+deploy,
# so the program you deploy to is always the one you named. .aio is gitignored, so
# rewriting it produces no diff.
#
# Usage:  ./deploy.sh <target>        e.g. ./deploy.sh writing
#
set -euo pipefail
cd "$(dirname "$0")"

TARGET="${1:-}"
KNOWN="$(node -e 'console.log(Object.keys(require("./deploy-targets.json").targets).join(", "))')"

if [[ -z "$TARGET" ]]; then
  echo "usage: ./deploy.sh <target>   (targets: $KNOWN)" >&2
  exit 2
fi

# Resolve the target to "orgId programId siteDomain"; node exits non-zero if the
# target name is unknown, which fails the script here.
INFO="$(node -e '
  const cfg = require("./deploy-targets.json");
  const t = cfg.targets[process.argv[1]];
  if (!t) { console.error("unknown target: " + process.argv[1] + " (known: '"$KNOWN"')"); process.exit(1); }
  process.stdout.write([cfg.orgId, t.programId, t.siteDomain].join(" "));
' "$TARGET")" || exit 1
read -r ORG PROGRAM SITE <<<"$INFO"

echo "→ deploying target '$TARGET': program $PROGRAM, site $SITE"

# Match the existing .aio format (unquoted keys, as aio writes it).
cat > .aio <<EOF
{
  cloudmanager_orgid: "$ORG",
  cloudmanager_programid: "$PROGRAM",
  edgefunctions_edge_delivery: true,
  edgefunctions_site_domain: "$SITE"
}
EOF

aio aem edge-functions build
aio aem edge-functions deploy docket-auth

echo "✓ docket-auth deployed to program $PROGRAM ($SITE)"
