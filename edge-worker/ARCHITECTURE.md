# Docket auth edge function — how it works

This document explains the `edge-worker/` auth system end to end: the request
flow, the components, the config/secret model, deployment, the workarounds we had
to apply for pipeline bugs, and the known limitations (including the sign-out
behavior).

## What it does

The whole site is put behind Adobe IMS sign-in with an **all-or-nothing** gate:

- A visitor **without** a valid `docket_session` cookie sees only a login screen.
- A visitor **with** a valid cookie has their request transparently proxied to
  the AEM Edge Delivery origin — full access to everything.

Authorization is an allowlist: after IMS proves *who* you are, a **visitors**
list in the site's da.live config decides *whether* you're allowed in (by exact
email or `@domain.com` wildcard).

It runs as an **AEM Edge Function** (Fastly Compute, WebAssembly) on the Adobe
CDN, in front of the site's custom domain.

## Request flow

```
Browser ──▶ Adobe CDN ──(cdn.yaml routes the gated host)──▶ docket-auth edge function
                                                             │
                         ┌───────────────────────────────────┤
                         ▼                                   ▼
                 valid docket_session?               /auth/session (POST/DELETE)
                    │           │                            │
                   yes          no                    IMS verify + allowlist
                    ▼           ▼                            │
             proxy to AEM   login page (401)          set/clear cookie
             origin (200)                                    │
                                                     (client reloads → proxied)
```

### 1. Anonymous request → login page
`src/index.js` resolves which site the request targets (see *Multi-site*), reads
the `docket_session` cookie, and — finding none/invalid — returns the
self-contained login page from `src/login.js` with HTTP 401, for **any** path.
Nothing is fetched from the origin, so no content leaks.

### 2. Sign-in (OAuth implicit, no imslib)
The login page runs the IMS **implicit** flow directly (see *Why no imslib*):
1. "Sign in" → full-page redirect to `/ims/authorize/v2?...response_type=token&redirect_uri=<site>/&state=<nonce>`.
2. IMS authenticates and redirects back with `#access_token=…&state=…` in the URL.
3. The page reads the token from its **own** URL fragment (same-origin — no CORS),
   verifies the `state` nonce (CSRF), strips the token from the URL, and POSTs it
   to `/auth/session`.

### 3. `/auth/session` (POST) — `src/handlers/auth.js`
1. **CSRF**: the `Origin` header must be one of the configured site hosts.
2. **Site**: the request host must resolve to a configured site.
3. **Authentication**: the access token is sent to the IMS **profile** endpoint;
   IMS itself validates it (a 401/403 = rejected). The user's **email** comes from
   the profile response; `created_at`/`expires_in` from the token's JWT claims.
4. **Authorization**: a confidential `client_credentials` service token is minted
   and used to read `admin.da.live/config/<org>/<site>/` → `visitors.data`. The
   email (or its `@domain`) must be on that list.
5. On success, an HMAC-signed **`docket_session`** cookie (+ a readable
   `docket_session_active` hint cookie) is set. The client reloads; the request
   now has the cookie and is proxied.

Everything **fails closed**: a missing secret, unreachable IMS or da.live, or an
empty allowlist all deny.

### 4. Authenticated request → proxy — `src/handlers/proxy.js`
The request is forwarded to `main--<site>--<org>.<suffix>` (e.g.
`main--red--adobegmo.aem.page`). The `docket_session` cookie is stripped before it
leaves the edge, `x-forwarded-host` is set to the public host, and the origin
response is returned verbatim.

## Session model

The session is a **stateless, self-contained cookie** — there is no server-side
session store:

- `docket_session` = `base64url(claimsJSON).base64url(HMAC-SHA256)`, signed with
  `SESSION_SECRET`. Claims = `{ email, created_at, expires_in }`.
- Flags: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. TTL = min(IMS token
  expiry, `SESSION_MAX_AGE_MS`, default 24h).
- Verified locally per request (HMAC + expiry) — no network, no store.
- `docket_session_active` is a non-HttpOnly companion carrying only the expiry, so
  client JS can tell a session exists.

**Implication:** the cookie is decoupled from IMS session state. Signing out of
`adobe.com` does **not** revoke it — see *Limitations → sign-out*.

## Multi-site (repoless)

One code base gates many sites. `SITES` (a config map of `host → { org, site }`)
is resolved **per request from the public host**. The public host arrives in the
**`x-forwarded-host`** header (behind the CDN the request URL's own host is an
internal `edgefunction-…adobeaemcloud.com`), so `src/index.js` checks
`x-forwarded-host` → `host` → `url.host` in order. To add a site: add a `SITES`
entry **and** a per-host rule in `cdn.yaml`, then re-run the config pipeline.

## Components

| File | Responsibility |
| --- | --- |
| `src/index.js` | Entry; site resolution; route `/auth/session` vs proxy/login |
| `src/login.js` | Self-contained login page (imslib-free implicit OAuth) |
| `src/handlers/auth.js` | `/auth/session` POST (login) / DELETE (logout) |
| `src/handlers/proxy.js` | Authenticated passthrough to the AEM origin |
| `src/lib/session.js` | HMAC cookie mint/verify (pure) |
| `src/lib/jwt.js` | JWT decode, no signature check (pure) |
| `src/lib/allowlist.js` | `isVisitorAllowed(email, rows)` (pure) |
| `src/lib/sites.js` | `SITES` parse + host → site resolution (pure) |
| `src/lib/env.js` | Reads config store + secret store into an env object |
| `src/lib/secrets.js` | Secret store accessor |
| `config/edgeFunctions.yaml` | Declares the function, configs, secrets |
| `config/cdn.yaml` | Routes gated hosts to the function |

## Configuration & secrets

- **Configs** (`config_default`, read sync): `SITES`, `AEM_HOST_SUFFIX`, `IMS_ENV`,
  `IMS_CLIENT_ID_PUBLIC` (browser client), `IMS_CLIENT_ID` + `IMS_SCOPE` (S2S
  service identity), optional `SESSION_MAX_AGE_MS`.
- **Secrets** (`secret_default`, read async): the real `SESSION_SECRET` and
  `IMS_CLIENT_SECRET`, packed into **`APP_SECRETS`** (see workaround below).

### Two IMS credentials
- **Public browser client** (`IMS_CLIENT_ID_PUBLIC`, e.g. `adobegmo`): the user's
  sign-in + the profile lookup. Needs the site's redirect URI registered.
- **Confidential Server-to-Server** (`IMS_CLIENT_ID`/secret/`IMS_SCOPE`): reads
  the da.live visitors config. Its technical account must be granted read access
  to `admin.da.live/config/<org>/<site>`.

## Deployment

- **Config** (`edgeFunctions.yaml` + `cdn.yaml`): deployed by a Cloud Manager
  **Edge Delivery config pipeline** reading this repo's `main`, code location
  `/edge-worker/config`. Re-run it after any config/secret change.
- **Function code**: `aio aem edge-functions build && aio aem edge-functions deploy docket-auth`
  (needs the Deployment Manager role; **not** part of BYOG site-code sync).
- **Secret values**: Cloud Manager **pipeline variables** referenced via `${{…}}`.

## Workarounds we had to apply

These exist because of platform bugs, not by preference. Remove them once fixed.

1. **`SITES` is base64-encoded** (`config/edgeFunctions.yaml` + `parseSites`).
   The CDN config generator (**SKYOPS-157895**) crashes/mangles a config value
   containing YAML/HTML-special characters — a raw JSON object breaks it. base64
   has none of those. `parseSites` accepts raw JSON too, so revert when fixed.

2. **Both secrets packed into one variable** (`APP_SECRETS` ← `${{DOCKET_SESSION_SECRET}}`,
   split in `env.js`). A **second** `${{…}}` secret variable resolves **empty** in
   the generated secret bundle (`DOCKET_IMS_CLIENT_SECRET`, set non-empty, arrived
   empty regardless of declaration order, while `DOCKET_SESSION_SECRET` worked).
   So both real secrets are stored as a base64 JSON blob in the one working
   variable. `env.js` still falls back to individual `SESSION_SECRET`/
   `IMS_CLIENT_SECRET` keys (used by local dev and after the bug is fixed).
   > Set it with:
   > `node -e 'console.log(Buffer.from(JSON.stringify({SESSION_SECRET:"<hex>",IMS_CLIENT_SECRET:"<ims>"})).toString("base64"))'`
   > then `aio cloudmanager:set-pipeline-variables <pid> --programId <prog> --secret DOCKET_SESSION_SECRET "<base64>"`.

3. **imslib-free login** (`src/login.js`). imslib makes cross-origin XHRs to
   `/ims/check` that require the origin on the IMS client's CORS allowlist — a
   field this client doesn't expose. The plain implicit redirect + same-origin
   hash read needs only a registered redirect URI. The worker validates the token
   server-side, so we lose nothing.

4. **Host from `x-forwarded-host`** (`src/index.js`). Behind the CDN, the request
   URL host is internal; the real host is in `x-forwarded-host`.

## Local development

`cd edge-worker && aio aem edge-functions serve` → `http://127.0.0.1:7676`. Local
config/secrets come from `fastly.toml` (individual `SESSION_SECRET`/
`IMS_CLIENT_SECRET`, raw JSON `SITES`). `npm test` runs the unit tests.

## Limitations

- **Sign-out is not synced with IMS.** Because the session is a standalone cookie
  (no server store, and we don't re-check IMS per request), signing out of
  `adobe.com` does **not** end the `docket_session`. It stays valid until it
  expires (≤24h) or the user hits `DELETE /auth/session`. Real-time IMS-sign-out
  propagation isn't feasible here without imslib (blocked by the same CORS issue
  as #3 above). Practical mitigations: a shorter `SESSION_MAX_AGE_MS`, and/or an
  explicit "Sign out" control that calls `DELETE /auth/session`.
- **Every request is proxied** through the function for gated hosts (all-or-nothing),
  so each pays the function + one origin subrequest. Acceptable for a gated site;
  revisit if per-user personalization is ever needed.
- **TLS/cert** is handled by the Adobe Managed CDN, not this function.

## Common operations

- **Add a gated site:** add a `SITES` entry (regenerate the base64) + a per-host
  rule in `cdn.yaml`; re-run the config pipeline.
- **Update the visitors allowlist:** edit the `visitors` sheet in the site's
  da.live config — no deploy needed (read live per login).
- **Rotate secrets:** regenerate the `APP_SECRETS` base64 blob, re-set
  `DOCKET_SESSION_SECRET`, re-run the config pipeline. Rotating the session HMAC
  invalidates all live cookies.
