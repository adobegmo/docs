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
| `config/cdn.yaml` | CDN routing: per-host rule → this function |
| `fastly.toml` | Local dev only: backends + local config/secret stores |
| `deploy.sh` | Target-scoped deploy wrapper (rewrites `.aio` per program, then build + deploy) |
| `deploy-targets.json` | Program / pipeline / domain for each deploy target |

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
4. Cloud Manager secret `DOCKET_SESSION_SECRET` — a base64-encoded JSON bundle
   `{ "SESSION_SECRET": "<hex>", "IMS_CLIENT_SECRET": "<ims-secret>" }` carrying
   both real secrets in one variable (see the SKYOPS-157895 workaround note in
   `config/edgeFunctions.yaml`; a second `${{...}}` secret resolves empty in the
   CDN config generator, so `DOCKET_IMS_CLIENT_SECRET` is no longer used).

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
npm run deploy:red                  # ./deploy.sh red     → program 223257
npm run deploy:writing              # ./deploy.sh writing → program 223466
npm run tail                        # stream logs (from whatever .aio points at)
```

The worker runs in **more than one Cloud Manager program** (one per gated site
family — see `deploy-targets.json`). `aio aem edge-functions deploy` has no
program flag; it targets whatever `.aio` holds. So deploy via the target-scoped
scripts above — `deploy.sh` rewrites `.aio` for the named program before every
build+deploy, so you can't cross-deploy one site's code into another. Raw
`npm run deploy` still works but acts on whatever `.aio` last pointed at.

In Cloud Manager, add this repo under **Repositories**, then create — **per
program** — an **Edge Delivery configuration pipeline** whose Source Code step
points at this repo, the `main` branch, and **`/edge-worker/config`** as the *Code
Location* (the pipeline lets you pick a subfolder). Running it deploys
`edgeFunctions.yaml` + `cdn.yaml`.

To gate an **additional** site: add a `SITES` entry in `edgeFunctions.yaml` **and**
a matching per-host rule in `cdn.yaml`. If the site lives in an **existing**
program, just re-run that program's config pipeline (no code redeploy — the
function is multi-site). If it needs a **new** program, also register its Edge
Delivery site/domain/SSL, set `DOCKET_SESSION_SECRET` on the new pipeline, add a
target to `deploy-targets.json`, and `./deploy.sh <target>`. See
`ARCHITECTURE.md` → *Common operations*.
