/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/*
 * Pure multi-site resolution. One repoless EDS code repo fronts many sites, so
 * the target org/site is resolved per request from the request Host against the
 * SITES config map, rather than a single static org/site. No platform bindings,
 * so this is unit-testable in isolation.
 *
 * SITES is a JSON object keyed by public host:
 *   {
 *     "preview.red.adobe.com": { "org": "adobegmo", "site": "red" },
 *     "preview.blue.adobe.com": { "org": "adobegmo", "site": "blue", "hostSuffix": "aem.live" }
 *   }
 * hostSuffix is optional per entry and falls back to env.AEM_HOST_SUFFIX.
 */

// prod → the imslib 'prod' environment; anything else → 'stg1'. Mirrors
// spectrum-hub scripts/utils/ims.js so the login page and the profile call agree.
export const imslibEnvironment = (imsEnv) => (imsEnv === 'prod' ? 'prod' : 'stg1');

const normalizeHost = (host) => (typeof host === 'string' ? host.trim().toLowerCase() : '');

const asSiteMap = (parsed) => (
  parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
);

const tryJson = (value) => {
  try {
    return asSiteMap(JSON.parse(value));
  } catch {
    return null;
  }
};

// Parses the SITES config once into a plain map. Any missing / malformed value
// yields an empty map, which denies every host - fail closed by construction.
//
// The DEPLOYED value is base64-encoded JSON, not raw JSON: the Adobe CDN config
// generator (SKYOPS-157895) crashes when a data.configs value is a JSON-object
// string - its Handlebars template re-emits the value unquoted and HTML-escaped,
// so the `{ } " :` (and the escaped `&quot;`) break the generator's own YAML
// parse and the whole CDN config fails to deploy. Encoding to base64 - which has
// no YAML/HTML-significant characters - sidesteps that. Local dev (fastly.toml)
// may still use raw JSON, so we try raw first, then base64-decode. Revert to raw
// JSON once SKYOPS-157895 ships; this parser keeps working either way.
export const parseSites = (env) => {
  const raw = env?.SITES ?? '{}';
  let result = tryJson(raw);
  if (result === null) {
    let decoded = null;
    try { decoded = atob(raw); } catch { decoded = null; }
    if (decoded !== null) { result = tryJson(decoded); }
  }
  return result ?? {};
};

// Resolves the target site for a request host, or null when the host is not a
// configured site (an unconfigured host is never proxied).
export const resolveSite = (env, host) => {
  const key = normalizeHost(host);
  if (key === '') { return null; }
  const entry = parseSites(env)[key];
  const org = typeof entry?.org === 'string' ? entry.org : '';
  const site = typeof entry?.site === 'string' ? entry.site : '';
  if (org === '' || site === '') { return null; }
  return {
    host: key,
    org,
    site,
    hostSuffix: (typeof entry.hostSuffix === 'string' && entry.hostSuffix !== '')
      ? entry.hostSuffix
      : (env.AEM_HOST_SUFFIX || 'aem.live'),
  };
};

// CSRF: the Origin of a /auth/session call must be one of the configured site
// hosts. Replaces a static ALLOWED_ORIGINS list - the site map IS the allowlist.
export const isKnownOriginHost = (env, origin) => {
  if (typeof origin !== 'string' || origin === '') { return false; }
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(parseSites(env), normalizeHost(host));
};
