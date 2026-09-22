# Docket auth edge function

An [AEM Edge Function](https://experienceleague.adobe.com/en/docs/experience-manager-learn/cloud-service/edge-functions/overview)
(Fastly Compute) that puts the whole site behind Adobe IMS sign-in with an
**all-or-nothing** access model:

- A request with a valid `docket_session` cookie is proxied transparently to the
  AEM Edge Delivery origin — full site access.
- Any other request gets a self-contained login page (HTTP 401); nothing is
  fetched from the origin, so no content leaks to an unauthenticated visitor.

Sign-in is Adobe IMS: the login page signs the user in via `imslib`, then POSTs
the access token to `/auth/session`. The function verifies the token with IMS,
reads the user's email from the IMS profile, and checks it against a **visitors**
allowlist stored in the site's private da.live config
(`admin.da.live/config/<org>/<site>/` → `visitors.data`). Allowlist entries are
either full email addresses or leading-`@` domain wildcards (e.g. `@adobe.com`).
On success it mints an HMAC-signed session cookie. Everything **fails closed**:
a missing secret, an unreachable IMS or da.live, or an empty allowlist all deny.

This is a simplified port of the AWS Lambda at
`spectrum-hub/workers/website-lambda` — the per-page audience gating, block
stripping, and query-index filtering are intentionally dropped.

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.js` | Entry (`addEventListener("fetch")`); routes `/auth/session` vs. proxy/login |
| `src/login.js` | Renders the edge login page (inlined imslib flow) |
| `src/handlers/auth.js` | `/auth/session` POST (login) / DELETE (logout): IMS + allowlist |
| `src/handlers/proxy.js` | Authenticated passthrough to the AEM origin |
| `src/lib/session.js` | HMAC-signed cookie mint/verify (pure) |
| `src/lib/jwt.js` | JWT decode, no signature check (pure) |
| `src/lib/allowlist.js` | `isVisitorAllowed(email, rows)` matcher (pure) |
| `src/lib/env.js` | Reads config store + secret store into a plain env object |
| `src/lib/secrets.js` | Secret store accessor (from the AEM boilerplate) |
| `config/edgeFunctions.yaml` | Declares the function, configs, and secret references |
| `config/cdn.yaml` | CDN routing: all paths → this function |
| `fastly.toml` | Local dev only: backends + local config/secret stores |

## Configuration

Non-sensitive values live in `config/edgeFunctions.yaml` `configs` (exposed via
the `config_default` config store):

- **`SITES`** — a JSON map that makes the worker **multi-site** (repoless: one
  code base fronts many sites). Each gated public host maps to its da.live
  `org`/`site`; the set of hosts also acts as the CSRF origin allowlist. Add one
  entry per site:
  ```json
  {
    "preview.red.adobe.com":  { "org": "adobegmo", "site": "red" },
    "preview.blue.adobe.com": { "org": "adobegmo", "site": "blue", "hostSuffix": "aem.live" }
  }
  ```
  `hostSuffix` is optional per entry and falls back to `AEM_HOST_SUFFIX`. The
  worker resolves the target site per request from the incoming Host; session
  cookies are host-only, so each site stays isolated.
- `AEM_HOST_SUFFIX` — default AEM tier (`aem.page` preview / `aem.live` published).
- `IMS_ENV`, `IMS_CLIENT_ID_PUBLIC` (browser OAuth client), `IMS_CLIENT_ID` +
  `IMS_SCOPE` (confidential service identity). Optional: `SESSION_MAX_AGE_MS`.

Secrets are Cloud Manager secrets referenced from `config/edgeFunctions.yaml`
`secrets`: `SESSION_SECRET`, `IMS_CLIENT_SECRET` (and optional
`ORIGIN_AUTHENTICATION`). **Never commit secret values.** IMS credentials and the
signing secret are shared across all sites in `SITES`; the visitor allowlist is
per-site (each site's own da.live config).

Because of a config-generator bug (a second `${{...}}` secret resolves empty), all
of these are packed into the **one** working secret variable `DOCKET_SESSION_SECRET`
as a base64 JSON bundle (`APP_SECRETS`) and split back apart in `src/lib/env.js`.

`ORIGIN_AUTHENTICATION` enables **token-based Site Authentication** on the AEM
origin: once set, `proxy.js` sends `Authorization: token <hlx_…>` on every upstream
request, so the `main--<site>--<org>.aem.page` origin can 401 everyone except this
worker. Because each site is its own Cloud Manager program with its own secret
bundle, each program carries **its own** token — `red` and `writing` are separate
AEM sites with **different** tokens and **separate** `access/preview.json` configs.
Minting the token and enabling the origin lock is an AEM admin-API step; see the
["Locking the AEM origin"](#locking-the-aem-origin) section below.

### Secrets & local `.env` files

Cloud Manager will not let you read a secret back once set, but rebuilding the
`APP_SECRETS` bundle to add or rotate any **one** value needs the current value of
the others. So each target keeps a gitignored **`.env.<env>.<site>`** file (`env`
is `test`|`prod`, `site` is `red`|`writing`|…) as the canonical local record — copy
[`.env.example`](.env.example) and fill it in. `SESSION_SECRET` (generate with
`openssl rand -hex 32`) and `IMS_CLIENT_SECRET` are the **same** across sites in an
environment (test and prod each get their own); `ORIGIN_AUTHENTICATION` is per-site;
`PROGRAM_ID`/`PIPELINE_ID` target that site's config pipeline.

Push a target's secrets with the helper (never hand-run the base64/`aio` steps):

| Target | Command |
| --- | --- |
| `test.red` (program 223257) | `npm run secrets:test:red` |
| `test.writing` (program 223466) | `npm run secrets:test:writing` |

`scripts/set-secrets.sh <env>.<site>` reads `.env.<env>.<site>`, packs the bundle,
and sets `DOCKET_SESSION_SECRET` on that program (values never touch argv or shell
history). `DRY_RUN=1 npm run secrets:test:red` shows what it would do without
changing anything. Redeploy afterwards (`npm run deploy:<site>`) so the function
reads the new bundle. **Never commit a filled-in `.env.*`; keep it off backups/sync.**

**Adding the prod targets (not set up yet):** prod reuses the **same AEM sites** on
the **`aem.live`** (published) tier — e.g. `main--red--adobegmo.aem.live`. For each
prod site:

- Add a prod host entry to `SITES` in `edgeFunctions.yaml` with
  `"hostSuffix": "aem.live"` (the map is shared across programs; each program serves
  its own registered host, resolving to the right tier per entry), plus a matching
  `cdn.yaml` rule for the prod host.
- Create its Cloud Manager program + Edge Delivery config pipeline; add a
  `.aio.prod.<site>` context and `secrets:prod:<site>` + `deploy:prod:<site>` npm
  scripts. (You may also rename the current `.aio.red`/`deploy:red` to the `test.`
  form then, so both dimensions read consistently.)
- Add a `.env.prod.<site>`: prod gets its **own** `SESSION_SECRET` and IMS client,
  but `ORIGIN_AUTHENTICATION` is the **same token as `.env.test.<site>`** — it is a
  per-*site* AEM secret, and one token covers both that site's `access/preview.json`
  and `access/live.json`.
- Lock the prod origin by POSTing that site token's `secretId` to
  `.../sites/<site>/access/live.json` (same as the preview steps below, but
  `live.json` instead of `preview.json`).

The helper needs no change — it keys off whatever `<env>.<site>` file you pass.

## Prerequisites (before deploy)

1. A **non-sandbox** Cloud Manager program with Edge Delivery Services + Edge
   Functions enabled, and the Deployment Manager role. (Sandbox programs cannot
   use config/secret/KV stores.)
2. Adobe Developer Console credentials: a **public** IMS OAuth client (browser
   sign-in + profile) with redirect URIs registered for the site domains, and a
   **confidential** `client_credentials` integration authorized to read the
   da.live config.
3. A `visitors` sheet in the site's da.live config with an `email` column,
   populated with allowed addresses / `@domain` wildcards.
4. Cloud Manager secrets `DOCKET_SESSION_SECRET` and `DOCKET_IMS_CLIENT_SECRET`.

## Local development

```bash
npm install
npm test                 # mocha unit tests (pure libs)
npm run serve            # aio aem edge-functions serve → http://127.0.0.1:7676
```

Local backends and local config/secret values are in `fastly.toml`; edit the
`aem-origin` backend and the local secrets to exercise the proxy path. Because
the login page is served by the function itself (same origin as `/auth/session`),
no CORS handling is needed.

Quick checks:

```bash
curl -i http://127.0.0.1:7676/any-page                      # 401 + login HTML
curl -i -X POST http://127.0.0.1:7676/auth/session          # 403 (no Origin)
```

## Deploy

```bash
npm install -g @adobe/aio-cli
aio plugins:install @adobe/aio-cli-plugin-aem-edge-functions
aio login
aio aem edge-functions setup        # writes the .aio context

npm run build                       # aio aem edge-functions build
npm run deploy                      # aio aem edge-functions deploy docket-auth (current .aio target)
npm run tail                        # stream runtime logs
```

### Choosing a deploy target (multi-site)

`aio aem edge-functions deploy` has **no `--program` flag** — it deploys to
whichever Cloud Manager org/program is recorded in the local **`.aio`** context
file. Because this is a repoless/multi-site setup (one code base fronts several
sites, each its own Cloud Manager program), deploying to a specific site means
pointing `.aio` at that site first. The active `.aio` is gitignored; one
committed **`.aio.<name>`** template per site records each site's org/program:

| Site | Command |
| --- | --- |
| `test.red.adobe.com` (program 223257) | `npm run deploy:red` |
| `test.writing.adobe.com` (program 223466) | `npm run deploy:writing` |

Each `deploy:<name>` swaps `.aio` to that site's template, then builds and
deploys. `npm run tail:red` / `tail:writing` stream logs from the matching
target. To switch context without deploying: `npm run context:use -- <name>`.

**Onboard a new site's deploy target:** run `aio aem edge-functions setup`
(pick its org/program/domain), then `npm run context:save -- <name>` to capture
it as `.aio.<name>`. Commit that template and add a `deploy:<name>` script.

In Cloud Manager, add this repo under **Repositories**, then create an **Edge
Delivery configuration pipeline** whose Source Code step points at this repo, the
`main` branch, and **`/edge-worker/config`** as the *Code Location* (the pipeline
lets you pick a subfolder). Running it deploys `edgeFunctions.yaml` + `cdn.yaml`.

To gate an **additional** site later: add a `SITES` entry in `edgeFunctions.yaml`
**and** a matching per-host rule in `cdn.yaml`, then re-run the config pipeline
(no function code change or redeploy needed).

## Locking the AEM origin

The worker gates the *public* host, but `main--<site>--<org>.aem.page` is still
directly reachable and bypasses auth. Token-based Site Authentication makes the AEM
origin 401 everyone except this worker. **Do it per site** — `red` and `writing`
are separate AEM sites with their own tokens and their own `access/preview.json`.

Do this once per site (example uses `red`; needs an AEM admin `x-auth-token`):

1. **Mint the site token** (save `id` and the `hlx_…` `value`, shown once):
   ```bash
   curl -X POST https://admin.hlx.page/config/adobegmo/sites/red/secrets.json \
     -H 'x-auth-token: <ADMIN_AUTH_TOKEN>'
   ```

2. **Put the token in that target's secret bundle and push it.** Add the `hlx_…`
   value to that target's gitignored `.env.<env>.<site>` (`ORIGIN_AUTHENTICATION=…`),
   then:
   ```bash
   npm run secrets:test:red   # packs .env.test.red into APP_SECRETS + sets the pipeline var
   npm run deploy:red         # redeploy so the function reads the new bundle
   ```
   (`scripts/set-secrets.sh` builds the base64 bundle and calls
   `aio cloudmanager:set-pipeline-variables` for you — see
   [Secrets & local `.env` files](#secrets--local-env-files).)

3. **Verify the worker still reaches the origin — BEFORE locking:** sign in at
   `https://test.red.adobe.com/` and confirm pages (and images) still load.

4. **Enable access control on the preview tier** (GET first to preserve any
   existing config; each POST overwrites the object):
   ```bash
   curl -X POST https://admin.hlx.page/config/adobegmo/sites/red/access/preview.json \
     -H 'content-type: application/json' -H 'x-auth-token: <ADMIN_AUTH_TOKEN>' \
     --data '{ "secretId": ["<SECRET_ID_FROM_STEP_1>"] }'
   ```
   (`preview.json` locks `aem.page` only, matching `AEM_HOST_SUFFIX`.)

5. **Verify the lockdown:**
   ```bash
   curl -sI https://main--red--adobegmo.aem.page/ | head -1                              # expect 401
   curl -sI https://main--red--adobegmo.aem.page/ -H 'authorization: token hlx_…' | head -1  # expect 200
   ```
   Then confirm `https://test.red.adobe.com/` still serves content through the worker.

Repeat all five steps for `writing` (its own token, program `223466`,
`.../sites/writing/...`). Because every path — including `media_*` — is proxied
through the function, no separate media/CDN header is needed (unlike a BYO
CloudFront setup).

**Rotation:** mint a new token, POST `access/preview.json` with both the old and
new `secretId`s, rebuild that program's bundle with the new value + redeploy, then
POST again with only the new `secretId`.
