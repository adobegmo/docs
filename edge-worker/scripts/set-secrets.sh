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
# The per-target values live in a gitignored `.env.<env>.<site>` file (see
# .env.example), e.g. .env.test.red. Cloud Manager cannot read a secret back once
# set, so that file is the canonical local record - keep it out of backups/sync.
#
# Usage:
#   scripts/set-secrets.sh <target>            # <target> = <env>.<site>, e.g. test.red
#   DRY_RUN=1 scripts/set-secrets.sh test.red  # print what it would do, set nothing
#
# Required in .env.<target>: PROGRAM_ID, PIPELINE_ID, SESSION_SECRET,
# IMS_CLIENT_SECRET. Optional: ORIGIN_AUTHENTICATION (the site's aem.page/aem.live
# token; omit until that origin is locked).
set -eu

name="${1:-}"
if [ -z "$name" ]; then
  echo "usage: $0 <target>   (<env>.<site>, e.g. test.red | test.writing)" >&2
  echo "env files present:" >&2
  ls .env.* 2>/dev/null | grep -v '\.example$' | sed 's/^\.env\./  /' >&2 || echo "  (none)" >&2
  exit 1
fi

ENV_FILE=".env.$name"
[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE (copy .env.example and fill it in)." >&2; exit 1; }

# Parse KEY=VALUE without sourcing (never eval a secrets file). The value keeps
# everything after the first '=', so base64 '=' padding survives intact.
PROGRAM_ID=; PIPELINE_ID=; SESSION_SECRET=; IMS_CLIENT_SECRET=; ORIGIN_AUTHENTICATION=
while IFS='=' read -r key val; do
  case "$key" in
    ''|\#*) continue ;;
    PROGRAM_ID) PROGRAM_ID="$val" ;;
    PIPELINE_ID) PIPELINE_ID="$val" ;;
    SESSION_SECRET) SESSION_SECRET="$val" ;;
    IMS_CLIENT_SECRET) IMS_CLIENT_SECRET="$val" ;;
    ORIGIN_AUTHENTICATION) ORIGIN_AUTHENTICATION="$val" ;;
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

# Build the base64 JSON bundle. Values are passed via the environment (not argv),
# so they never appear in `ps`. ORIGIN_AUTHENTICATION is included only when set.
B64="$(SESSION_SECRET="$SESSION_SECRET" IMS_CLIENT_SECRET="$IMS_CLIENT_SECRET" \
  ORIGIN_AUTHENTICATION="$ORIGIN_AUTHENTICATION" node -e '
  const b = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    IMS_CLIENT_SECRET: process.env.IMS_CLIENT_SECRET,
  };
  if (process.env.ORIGIN_AUTHENTICATION) { b.ORIGIN_AUTHENTICATION = process.env.ORIGIN_AUTHENTICATION; }
  process.stdout.write(Buffer.from(JSON.stringify(b)).toString("base64"));
')"

origin_state="set"; [ -z "$ORIGIN_AUTHENTICATION" ] && origin_state="omitted"
echo "Site '$name': program $PROGRAM_ID, pipeline $PIPELINE_ID (ORIGIN_AUTHENTICATION $origin_state)."

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN: would set DOCKET_SESSION_SECRET (base64 bundle, ${#B64} chars) - value not printed."
  echo "  aio cloudmanager:set-pipeline-variables $PIPELINE_ID --programId $PROGRAM_ID --secret DOCKET_SESSION_SECRET <bundle>"
  exit 0
fi

aio cloudmanager:set-pipeline-variables "$PIPELINE_ID" --programId "$PROGRAM_ID" \
  --secret DOCKET_SESSION_SECRET "$B64"
# Deploy scripts are keyed by site (deploy:red / deploy:writing); derive it from
# the <env>.<site> target for the redeploy hint.
site="${name##*.}"
echo "Done. Redeploy so the function reads the new bundle:  npm run deploy:$site"
