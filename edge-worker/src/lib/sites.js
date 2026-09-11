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

// Un-escapes HTML numeric character entities (e.g. "&#x3D;" -> "=", "&#61;" -> "=").
// The Adobe CDN config generator's Handlebars template HTML-escapes config values,
// and Handlebars' default escape set includes "=" -> "&#x3D;" (see decodeSites).
// Only numeric entities are handled - that is all the escaper emits for base64.
const unescapeNumericEntities = (s) => s
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));

// Decodes the SITES config value into a site map, or null if it cannot.
//
// Accepts, in order: raw JSON (local dev / fastly.toml), then base64/base64url of
// the JSON (the deployed form). The value is base64 to survive SKYOPS-157895 - the
// CDN config generator crashes on a raw JSON-object config value. But that same
// Handlebars escaping ALSO rewrites the base64 "=" PADDING to "&#x3D;", so plain
// atob(raw) failed on the deployed value and every host was denied. So we
// un-escape numeric entities, normalize base64url, strip padding, and re-pad
// before atob - robust to the mangling with no change to the stored value. Revert
// to a plain raw/atob path once SKYOPS-157895 ships; this keeps working either way.
const decodeSites = (value) => {
  const trimmed = String(value).trim();
  const asJson = tryJson(trimmed);
  if (asJson !== null) { return asJson; }

  const normalized = unescapeNumericEntities(trimmed)
    .replace(/\s+/g, '')
    .replace(/-/g, '+') // base64url -> base64
    .replace(/_/g, '/')
    .replace(/=+$/g, ''); // drop padding (escaped or literal) so we can re-add it
  let padded = normalized;
  while (padded.length % 4 !== 0) { padded += '='; }

  let decoded = null;
  try { decoded = atob(padded); } catch { decoded = null; }
  return decoded === null ? null : tryJson(decoded);
};

// Parses the SITES config once into a plain map. Any missing / malformed value
// yields an empty map, which denies every host - fail closed by construction.
export const parseSites = (env) => {
  const raw = env?.SITES ?? '{}';
  return decodeSites(raw) ?? {};
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
