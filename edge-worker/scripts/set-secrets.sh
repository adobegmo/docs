#!/usr/bin/env sh
#
# Pack a site's secrets into the APP_SECRETS bundle and set it as that site's
# Cloud Manager pipeline variable (DOCKET_SESSION_SECRET).
#
# Because a SECOND ${{...}} secret variable resolves EMPTY in the Adobe CDN config
# generator, every real secret ships inside the ONE working variable as a base64
# JSON bundle, split back apart in src/lib/env.js. This script builds that bundle
# from a gitignored per-site env file and pushes it, so you never hand-run the
# node one-liner (and never put secret values on the command line or in history).
#
# The per-target values live in a gitignored `.env.<target>` file (see
# .env.example), e.g. .env.test.red. Cloud Manager cannot read a secret back once
# set, so that file is the canonical local record - keep it out of backups/sync.
# A target is one Cloud Manager program: `<env>.<site>` when the program fronts
# one site (test.red), or just `<env>` when it fronts several (prod = red + writing
# in one program, so they share ONE bundle and ONE file).
#
# Usage:
#   scripts/set-secrets.sh <target>            # e.g. test.red | test.writing | prod
#   DRY_RUN=1 scripts/set-secrets.sh test.red  # print what it would do, set nothing
#
# Required in .env.<target>: PROGRAM_ID, PIPELINE_ID, SESSION_SECRET,
# IMS_CLIENT_SECRET. Optional AEM origin tokens (omit until that origin is locked),
# using ONE of these forms:
#   ORIGIN_AUTHENTICATION=hlx_...          single-site program
#   ORIGIN_AUTHENTICATION_<SITE>=hlx_...   one line per site on a multi-site program
#                                          (e.g. ORIGIN_AUTHENTICATION_RED); packed
#                                          as ORIGIN_AUTHENTICATION_BY_SITE { red: ... }
set -eu

name="${1:-}"
if [ -z "$name" ]; then
  echo "usage: $0 <target>   (e.g. test.red | test.writing | prod)" >&2
  echo "env files present:" >&2
  ls .env.* 2>/dev/null | grep -v '\.example$' | sed 's/^\.env\./  /' >&2 || echo "  (none)" >&2
  exit 1
fi

ENV_FILE=".env.$name"
[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE (copy .env.example and fill it in)." >&2; exit 1; }

# Parse KEY=VALUE without sourcing (never eval a secrets file). The value keeps
# everything after the first '=', so base64 '=' padding survives intact.
# Per-site origin tokens are collected as "<site>=<token>" lines (site lowercased).
NL='
'
PROGRAM_ID=; PIPELINE_ID=; SESSION_SECRET=; IMS_CLIENT_SECRET=; ORIGIN_AUTHENTICATION=
SITE_TOKENS=; site_names=
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in *=*) ;; *) continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  case "$key" in
    ''|\#*) continue ;;
    PROGRAM_ID) PROGRAM_ID="$val" ;;
    PIPELINE_ID) PIPELINE_ID="$val" ;;
    SESSION_SECRET) SESSION_SECRET="$val" ;;
    IMS_CLIENT_SECRET) IMS_CLIENT_SECRET="$val" ;;
    ORIGIN_AUTHENTICATION) ORIGIN_AUTHENTICATION="$val" ;;
    ORIGIN_AUTHENTICATION_?*)
      [ -z "$val" ] && continue
      site="$(printf '%s' "${key#ORIGIN_AUTHENTICATION_}" | tr '[:upper:]' '[:lower:]')"
      SITE_TOKENS="${SITE_TOKENS}${site}=${val}${NL}"
      site_names="$site_names $site"
      ;;
    *) ;; # ignore unknown keys
  esac
done < "$ENV_FILE"

missing=
for req in PROGRAM_ID PIPELINE_ID SESSION_SECRET IMS_CLIENT_SECRET; do
  eval "v=\$$req"
  [ -z "$v" ] && missing="$missing $req"
done
if [ -n "$missing" ]; then
  echo "ERROR: $ENV_FILE is missing:${missing}" >&2
  exit 1
fi

# The worker treats a per-site map as authoritative and ignores the single token,
# so having both is ambiguous - refuse rather than silently drop one.
if [ -n "$ORIGIN_AUTHENTICATION" ] && [ -n "$SITE_TOKENS" ]; then
  echo "ERROR: $ENV_FILE sets both ORIGIN_AUTHENTICATION and ORIGIN_AUTHENTICATION_<SITE>; use one form." >&2
  exit 1
fi

# Build the base64 JSON bundle. Values are passed via the environment (not argv),
# so they never appear in `ps`. Origin tokens are included only when set.
B64="$(SESSION_SECRET="$SESSION_SECRET" IMS_CLIENT_SECRET="$IMS_CLIENT_SECRET" \
  ORIGIN_AUTHENTICATION="$ORIGIN_AUTHENTICATION" SITE_TOKENS="$SITE_TOKENS" node -e '
  const b = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    IMS_CLIENT_SECRET: process.env.IMS_CLIENT_SECRET,
  };
  if (process.env.ORIGIN_AUTHENTICATION) { b.ORIGIN_AUTHENTICATION = process.env.ORIGIN_AUTHENTICATION; }
  const bySite = {};
  for (const line of (process.env.SITE_TOKENS || "").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) { bySite[line.slice(0, i)] = line.slice(i + 1); }
  }
  if (Object.keys(bySite).length) { b.ORIGIN_AUTHENTICATION_BY_SITE = bySite; }
  process.stdout.write(Buffer.from(JSON.stringify(b)).toString("base64"));
')"

if [ -n "$SITE_TOKENS" ]; then
  origin_state="per-site:$site_names"
elif [ -n "$ORIGIN_AUTHENTICATION" ]; then
  origin_state="single token"
else
  origin_state="omitted"
fi
echo "Target '$name': program $PROGRAM_ID, pipeline $PIPELINE_ID (origin auth: $origin_state)."

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN: would set DOCKET_SESSION_SECRET (base64 bundle, ${#B64} chars) - value not printed."
  echo "  aio cloudmanager:set-pipeline-variables $PIPELINE_ID --programId $PROGRAM_ID --secret DOCKET_SESSION_SECRET <bundle>"
  exit 0
fi

aio cloudmanager:set-pipeline-variables "$PIPELINE_ID" --programId "$PROGRAM_ID" \
  --secret DOCKET_SESSION_SECRET "$B64"
# Deploy scripts are keyed by <env>:<site> (deploy:test:red / deploy:prod:writing).
# A single-site target maps straight across; a multi-site target (prod) shares one
# program, so any of its sites' deploy scripts redeploys it.
case "$name" in
  *.*) echo "Done. Redeploy so the function reads the new bundle:  npm run deploy:$(echo "$name" | tr . :)" ;;
  *)   echo "Done. Redeploy so the function reads the new bundle:  npm run deploy:$name:<site> (any one site on this program)" ;;
esac
