# Docket auth — setup on a new Cloud Manager program

This is the end-to-end runbook for standing up the `docket-auth` edge function on
a **fresh Cloud Manager Edge Delivery program**. It assumes the code in
`edge-worker/` already exists (this repo); what follows is everything *outside*
the code you have to create, wire up, and deploy.

For *how the system works* once it is running, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).
The known platform-bug workarounds referenced below (base64 `SITES`, packed
`APP_SECRETS`) are explained there too.

---

## 0. Prerequisites

- **Adobe Cloud Manager** access to the target org, with the **Deployment Manager**
  and **Business Owner** (or equivalent) roles — you need to create pipelines *and*
  set pipeline variables and deploy edge-function code.
- **Node.js ≥ 22.12** (the `aio` edge-functions plugin uses `require(ESM)`; Node 24
  is fine, but earlier 22.x throws `ERR_REQUIRE_ESM`). Use one install of `aio` —
  a stray `/usr/local/bin/aio` will shadow the nvm one; check with `which -a aio`.
- **AIO CLI** with the AEM edge-functions plugin:
  ```bash
  npm install -g @adobe/aio-cli
  aio plugins:install @adobe/aio-cli-plugin-aem-edge-functions   # if not bundled
  aio login
  aio cloudmanager:org:select        # REQUIRED — set-pipeline-variables silently no-ops without an org selected
  ```
- **da.live** (Document Authoring) config access for the site's org, to edit the
  `visitors` allowlist.
- Two **Adobe IMS credentials** (created in the Adobe Developer Console — see step 5).

---

## 1. Create the Edge Delivery site in Cloud Manager

1. In Cloud Manager, create (or open) the **Edge Delivery Services** program.
2. Add the **site** and its **custom domain** (the gated public host, e.g.
   `test.red.adobe.com`). Complete DNS + TLS so the Adobe Managed CDN serves the
   domain over HTTPS. (TLS/cert is entirely CDN-side; the worker never touches it.)
3. Note the program's identifiers — you'll need them throughout:
   - **Program ID** (e.g. `223257`)
   - **Config pipeline ID** and **code-deploy pipeline ID** (from step 4/6)
   - Your **org**, **site**, and the AEM tier host `main--<site>--<org>.<suffix>`
     (e.g. `main--red--adobegmo.aem.page`) that the worker proxies to.

---

## 2. Bring-Your-Own-Git (BYOG) / repo wiring

The config + worker code are read from **this GitHub repo's `main`**. If the
program uses an Adobe-managed repo instead, mirror `main` to it.

- **Validate the repo** in Cloud Manager (Repositories → Add). Private-repo
  validation needs the challenge file at exactly:
  ```
  .well-known/adobe/cloud-manager-challenge      (hyphenated, NO .txt extension)
  ```
  Put the challenge value Cloud Manager gives you in that file on `main`, install
  the Cloud Manager GitHub app on the repo, then validate.
- If using a managed repo you cloned empty: `git remote add adobe <managed-url>`
  then `git push adobe main`.

---

## 3. Fill in the deployment-specific config

Edit [`config/edgeFunctions.yaml`](./config/edgeFunctions.yaml) for the new
deployment. Everything under `configs:` is non-sensitive and committed to Git.

| Key | What to set |
| --- | --- |
| `SITES` | **base64** of `{"<host>":{"org":"<org>","site":"<site>"}}` — one entry per gated host (see below). |
| `AEM_HOST_SUFFIX` | `aem.page` (preview) or `aem.live` (published) — the origin tier the worker proxies to. |
| `IMS_ENV` | `prod` \| `stage` \| `dev` — selects the IMS host + imslib environment. |
| `IMS_CLIENT_ID_PUBLIC` | The **public** browser client id (step 5a). |
| `IMS_CLIENT_ID` | The **confidential** Server-to-Server client id (step 5b). |
| `IMS_SCOPE` | Scopes for the S2S `client_credentials` token (step 5b). |

**Generate the `SITES` value** (⚠️ it is base64-encoded to dodge SKYOPS-157895 —
a raw JSON object crashes the CDN config generator):

```bash
node -e 'console.log(Buffer.from(JSON.stringify({"test.red.adobe.com":{org:"adobegmo",site:"red"}})).toString("base64"))'
```

Paste the output as the `SITES` value. For multiple gated hosts, put them all in
the one object before encoding.

---

## 4. Add the CDN routing rule(s)

Edit [`config/cdn.yaml`](./config/cdn.yaml). Add **one `originSelectors` rule per
gated host** — routing that host to the `edgefunction-docket-auth` origin with
`skipCache: true`:

```yaml
- name: gate-<yoursite>
  when:
    reqProperty: domain
    equals: "test.red.adobe.com"
  action:
    type: selectAemOrigin
    originName: edgefunction-docket-auth
    skipCache: true
```

> **Do not** use a blanket/catch-all match. A config pipeline applies `cdn.yaml`
> to **every** domain in the program, so a catch-all would route (and lock out)
> ungated repoless sites. Gate per host, and keep every gated host in **both**
> `cdn.yaml` **and** `SITES`.

---

## 5. Create the two IMS credentials (Adobe Developer Console)

### 5a. Public browser client (`IMS_CLIENT_ID_PUBLIC`)
Used by imslib for user sign-in and the profile lookup. In the Developer Console
project, add an OAuth **Web / SPA** (public) credential and configure:
- **Redirect URIs / allowed redirects:** every gated origin (e.g.
  `https://test.red.adobe.com`).
- **CORS / allowed origins:** the **same** gated origins. imslib makes a
  cross-origin `/ims/check` XHR — without the CORS allowlist, sign-in fails with a
  CORS error and the login page cannot work. *(This is the single most common
  setup failure — verify it in DevTools during testing.)*

### 5b. Confidential Server-to-Server client (`IMS_CLIENT_ID` / secret / scope)
Used server-side to read the da.live visitors allowlist. Add an **OAuth
Server-to-Server** credential (`client_credentials`) and:
- Copy its **Client ID** → `IMS_CLIENT_ID`, its **Client Secret** → used in step 7.
- Copy its **scopes** → `IMS_SCOPE` (the working set here is
  `openid, AdobeID, additional_info.projectedProductContext, aem.frontend.all, read_organizations`).
- Grant its **technical account** read access to the site's da.live config
  (`admin.da.live/config/<org>/<site>`) — otherwise the allowlist read 403s and
  everyone is denied.

You also need a **session HMAC secret** (any high-entropy value), used to sign the
`docket_session` cookie:
```bash
node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
```

---

## 6. Create the pipelines in Cloud Manager

Two separate pipelines:

1. **Edge Delivery config pipeline** — deploys `edgeFunctions.yaml` + `cdn.yaml`.
   - Source: this repo's `main`; **code location** `/edge-worker/config`.
   - This is what applies `SITES`, the IMS config, and the CDN routing.
2. **Worker code** is *not* a pipeline — it's the `aio aem edge-functions` deploy
   in step 8. (Site code in `blocks/`/`scripts/` ships via **AEM Code Sync** on
   `main`, also no pipeline.)

---

## 7. Set the secret pipeline variable

Secrets are **never committed** — they live as Cloud Manager pipeline variables,
referenced from `edgeFunctions.yaml` as `${{DOCKET_SESSION_SECRET}}`.

⚠️ **Both real secrets are packed into this one variable.** A *second* `${{...}}`
secret variable resolves **empty** in the generated bundle, so `SESSION_SECRET`
and `IMS_CLIENT_SECRET` are stored together as a base64 JSON blob and split apart
in `src/lib/env.js`.

Build the blob and set it (use your session HMAC hex from 5 and the S2S client
secret from 5b):

```bash
node -e 'console.log(Buffer.from(JSON.stringify({SESSION_SECRET:"<hex>",IMS_CLIENT_SECRET:"<ims-client-secret>"})).toString("base64"))'
```

```bash
aio cloudmanager:set-pipeline-variables <configPipelineId> --programId <programId> --secret DOCKET_SESSION_SECRET "<base64-blob>"
```

> If this errors with `CLI_AUTH_NO_ORG`, run `aio cloudmanager:org:select` first —
> it otherwise silently no-ops. Reject `BLANK_VARIABLE_VALUE` errors by confirming
> the blob is non-empty.

---

## 8. Deploy

Order matters — config first (so the origin + routing exist), then worker code.

```bash
# 1. Config + CDN routing + secret: run the Edge Delivery CONFIG PIPELINE
#    (Cloud Manager UI → the config pipeline → Run). Re-run after ANY config/secret change.

# 2. Worker code (WASM). Needs the Deployment Manager role.
cd edge-worker
aio aem edge-functions build
aio aem edge-functions deploy docket-auth
```

- If deploy reports **`Edge Function not found: docket-auth`**, the config pipeline
  hasn't successfully provisioned the function yet — fix/re-run step 1 first.
- If the config pipeline fails with **"CDN Configuration could not be deployed"**,
  the most likely cause is an un-encoded special-character config value
  (SKYOPS-157895) — confirm `SITES` is base64, not raw JSON.

---

## 9. Populate the visitors allowlist (da.live)

In the site's da.live config (`admin.da.live/config/<org>/<site>/`), edit the
**`visitors`** sheet. Each row is either an exact email or an `@domain.com`
wildcard for a whole org:

```
cpeyer@adobe.com
@adobe.com
```

This is read **live on every sign-in** — no deploy needed to change who's allowed.

---

## 10. Verify end to end

1. Visit `https://<gated-host>/` anonymously → you get the **login page** (HTTP
   401), no site content.
2. **Sign in.** Open DevTools → **no `/ims/check` CORS error** (if there is one,
   fix the public client's CORS allowlist, step 5a — nothing else will work until
   this is clean).
3. Allowlisted user → redirected back, `docket_session` cookie set, full site
   access; the header shows the **profile/sign-out menu**.
4. Non-allowlisted user → "not authorized" (403 from `/auth/session`).
5. **Sign-out sync:** sign out of adobe.com in another tab, return and navigate →
   you land on the login page (via `/auth/logout`). One extra load is expected —
   see the sign-out section in `ARCHITECTURE.md`.

---

## Adding another gated site later

Repoless — one code base, many sites:

1. Add the host to `SITES` (regenerate the base64) in `edgeFunctions.yaml`.
2. Add a matching per-host rule in `cdn.yaml`.
3. Add the new origin to the **public IMS client's** redirect URIs **and** CORS
   allowlist (step 5a).
4. Grant the S2S technical account read access to the new site's da.live config.
5. Re-run the config pipeline. (No worker-code redeploy needed.)

---

## Quick reference — where each value goes

| Value | Lives in | Sensitive? |
| --- | --- | --- |
| Gated host → org/site map | `SITES` (base64) in `edgeFunctions.yaml` | no |
| CDN routing per host | `cdn.yaml` | no |
| Public browser client id | `IMS_CLIENT_ID_PUBLIC` in `edgeFunctions.yaml` | no |
| S2S client id + scopes | `IMS_CLIENT_ID` / `IMS_SCOPE` in `edgeFunctions.yaml` | no |
| Session HMAC secret | packed into `DOCKET_SESSION_SECRET` pipeline var | **yes** |
| S2S client secret | packed into `DOCKET_SESSION_SECRET` pipeline var | **yes** |
| Who is allowed in | da.live `visitors` sheet | — (live) |
