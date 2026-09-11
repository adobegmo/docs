# Docket auth edge function — how it works

This document explains the auth system end to end: the request flow, the edge
worker and the site-side chrome, the config/secret model, deployment, the
workarounds we had to apply for platform bugs, and the sign-out behavior.

## What it does

The whole site is put behind Adobe IMS sign-in with an **all-or-nothing** gate:

- A visitor **without** a valid `docket_session` cookie sees only a login screen.
- A visitor **with** a valid cookie has their request transparently proxied to
  the AEM Edge Delivery origin — full access to everything.

Authorization is an allowlist: after IMS proves *who* you are, a **visitors**
list in the site's da.live config decides *whether* you're allowed in (by exact
email or `@domain.com` wildcard). Signed-in users also get a **profile / sign-out
menu** in the site header (`blocks/profile/`, driven by `scripts/utils/ims.js`).

The gate runs as an **AEM Edge Function** (Fastly Compute, WebAssembly) on the
Adobe CDN, in front of the site's custom domain.

## Request flow

```
Browser ──▶ Adobe CDN ──(cdn.yaml routes the gated host)──▶ docket-auth edge function
                                                             │
                         ┌───────────────────────────────────┤
                         ▼                                   ▼
                 valid docket_session?          /auth/session (POST/DELETE) · /auth/logout (GET)
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

### 2. Sign-in (imslib)
The login page loads Adobe **imslib** (`imslib.min.js`) configured with the public
client id and IMS environment:
1. "Sign in" → `adobeIMS.signIn()` (imslib handles the IMS redirect + return).
2. On return, `onReady` calls `getAccessToken()` and POSTs the token to
   `/auth/session`, then reloads (now cookie'd → proxied).
3. A 403 from `/auth/session` = signed in but not on the allowlist → the page
   shows a "not authorized" message.

> imslib makes cross-origin XHRs to `/ims/check`, so the **`adobegmo` IMS client
> must have the gated origins on its CORS/allowed-origins list** (in addition to
> redirect URIs). If that ever regresses, an imslib-free implicit-flow version of
> `login.js` is in git history (before commit `49ab65d`) and needs only a redirect
> URI — swap it back in.

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

`DELETE /auth/session` and `GET /auth/logout` both clear the cookies (logout);
`/auth/logout` is a top-level GET used by the client reconciliation (below).

Everything **fails closed**: a missing secret, unreachable IMS or da.live, or an
empty allowlist all deny.

### 4. Authenticated request → proxy — `src/handlers/proxy.js`
The request is forwarded to `main--<site>--<org>.<suffix>` (e.g.
`main--red--adobegmo.aem.page`). The `docket_session` cookie is stripped before it
leaves the edge, `x-forwarded-host` is set to the public host, and the origin
response is returned verbatim.

## Client-side IMS (site chrome) — `scripts/utils/ims.js` + `blocks/profile/`

On **proxied (authenticated) pages**, the site header mounts a **profile block**
(`blocks/header/header.js` → `loadBlock`), which calls `loadIms()`:

- **Signed in** → renders an avatar button + native popover (display name, email,
  avatar from `cc-collab.adobe.io/profile`, and **Sign out**). `handleSignOut()`
  clears the worker session (`DELETE /auth/session`) then `adobeIMS.signOut()`.
- **Anonymous** → renders a "Sign in" button (`adobeIMS.signIn()`).
- **Reconciliation (sign-out sync):** if imslib reports **no** IMS token but a
  `docket_session_active` cookie lingers (you signed out of adobe.com elsewhere),
  it navigates to **`/auth/logout`**, clearing the cookie → the next load is the
  login page. `setSession()` re-establishes the cookie when it nears expiry
  (`docket_session_active` value = expiry; `dueForRefresh`).

This is a direct adaptation of spectrum-hub `scripts/utils/ims.js` (client id
`adobegmo`; hint cookie `docket_session_active`; plain JSON `/auth/session` POST,
no CloudFront SigV4 header).

## Session model

The session is a **stateless, self-contained cookie** — there is no server-side
session store:

- `docket_session` = `base64url(claimsJSON).base64url(HMAC-SHA256)`, signed with
  `SESSION_SECRET`. Claims = `{ email, created_at, expires_in }`.
- Flags: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. TTL = min(IMS token
  expiry, `SESSION_MAX_AGE_MS`, default 24h).
- Verified locally per request (HMAC + expiry) — no network, no store.
- `docket_session_active` is a non-HttpOnly companion (value = expiry), so client
  JS can tell a session exists and when to refresh it.

The cookie is the **hard gate**; client-side reconciliation makes an IMS sign-out
propagate quickly on top of it — see *Sign-out behavior*.

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
| `src/index.js` | Entry; site resolution; route `/auth/*` vs proxy/login |
| `src/login.js` | Self-contained login page (imslib) |
| `src/handlers/auth.js` | `/auth/session` POST/DELETE + `/auth/logout` GET |
| `src/handlers/proxy.js` | Authenticated passthrough to the AEM origin |
| `src/lib/session.js` | HMAC cookie mint/verify (pure) |
| `src/lib/jwt.js` | JWT decode, no signature check (pure) |
| `src/lib/allowlist.js` | `isVisitorAllowed(email, rows)` (pure) |
| `src/lib/sites.js` | `SITES` parse + host → site resolution (pure) |
| `src/lib/env.js` | Reads config store + secret store into an env object |
| `src/lib/secrets.js` | Secret store accessor |
| `config/edgeFunctions.yaml` · `config/cdn.yaml` | Function declaration · routing |
| *(site)* `scripts/utils/ims.js` | Client imslib: sign-in/out, session refresh, reconciliation |
| *(site)* `blocks/profile/` + `blocks/header/header.js` | Profile / sign-out menu in the header |

## Configuration & secrets

- **Configs** (`config_default`, read sync): `SITES`, `AEM_HOST_SUFFIX`, `IMS_ENV`,
  `IMS_CLIENT_ID_PUBLIC` (browser client), `IMS_CLIENT_ID` + `IMS_SCOPE` (S2S
  service identity), optional `SESSION_MAX_AGE_MS`.
- **Secrets** (`secret_default`, read async): the real `SESSION_SECRET` and
  `IMS_CLIENT_SECRET`, packed into **`APP_SECRETS`** (see workaround below).

### Two IMS credentials
- **Public browser client** (`IMS_CLIENT_ID_PUBLIC`, e.g. `adobegmo`): the user's
  sign-in + the profile lookup. Needs the gated origins as **redirect URIs *and*
  CORS/allowed origins** (imslib calls `/ims/check` cross-origin).
- **Confidential Server-to-Server** (`IMS_CLIENT_ID`/secret/`IMS_SCOPE`): reads
  the da.live visitors config. Its technical account must be granted read access
  to `admin.da.live/config/<org>/<site>`.

## Deployment

- **Config** (`edgeFunctions.yaml` + `cdn.yaml`): deployed by a Cloud Manager
  **Edge Delivery config pipeline** reading this repo's `main`, code location
  `/edge-worker/config`. Re-run it after any config/secret change.
- **Worker code**: `aio aem edge-functions build && aio aem edge-functions deploy docket-auth`
  (needs the Deployment Manager role; **not** part of BYOG site-code sync).
- **Site code** (`scripts/`, `blocks/`): pushed to `main` and served by AEM Code
  Sync at `main--<site>--<org>` (the tier the worker proxies) — no pipeline.
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

3. **Host from `x-forwarded-host`** (`src/index.js`). Behind the CDN, the request
   URL host is internal; the real host is in `x-forwarded-host`.

> Historical: the login was briefly **imslib-free** (implicit redirect + hash read)
> as a workaround while the IMS client lacked a CORS allowlist. That's now
> configured, so imslib is used again; the imslib-free `login.js` remains in git
> history as a fallback if the CORS setting regresses.

## Local development

`cd edge-worker && aio aem edge-functions serve` → `http://127.0.0.1:7676`. Local
config/secrets come from `fastly.toml` (individual `SESSION_SECRET`/
`IMS_CLIENT_SECRET`, raw JSON `SITES`). `npm test` runs the unit tests.

## Sign-out behavior

Sign-out **does** propagate from IMS to the site, via client-side reconciliation
(`scripts/utils/ims.js`), with one deliberate characteristic:

- Signing out from the **profile menu** clears the worker session immediately
  (`DELETE /auth/session`) and signs the user out of IMS.
- Signing out of **adobe.com elsewhere**: on the next site page load, `loadIms()`
  sees no IMS token + the lingering `docket_session_active` cookie and redirects
  to `/auth/logout`, ending the session.
- **One-page-load characteristic:** the worker gates on the *cookie*, which it
  verifies locally (no per-request IMS call). So the **first** load right after a
  global sign-out is still served from the valid cookie; imslib detects the
  sign-out *on* that load and the **next** navigation is the login page. Detecting
  it before the page is served would require the worker to check IMS per request
  (impractical: IMS's session cookies are on a different origin, and a network
  call per request/asset is too slow) or OIDC back-channel logout with a stateful
  revocation store. This is **not a security hole** — that person was an
  allowlisted user whose cookie would be valid for its full TTL regardless;
  reconciliation collapses the exposure from *up to 24h* to *one navigation*. The
  signed-cookie TTL is the hard boundary.

## Other characteristics

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
