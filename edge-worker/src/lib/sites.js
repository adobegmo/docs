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

// Un-escapes the numeric HTML entities the Adobe CDN config generator injects
// into the DEPLOYED config-store value (SKYOPS-157895 second-order bug): even
// though base64 has no HTML-significant characters, the generator's Handlebars
// template still HTML-escapes the `=` padding to `&#x3D;`, so a value committed
// as `...fQ==` arrives at runtime as `...fQ&#x3D;&#x3D;`. atob() then throws on
// the `&`/`#`/`;`, parseSites returns {}, and every host is denied. We reverse
// that here (both hex and decimal entities, plus &amp;) so the mangled value
// decodes identically to the clean one. Harmless on an un-mangled value.
const unescapeEntities = (s) => s
  .replace(/&amp;/g, '&')
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));

// Decodes a base64 (or base64url) config value to its string, tolerant of the
// entity mangling above and of missing/extra padding. Returns null if it is not
// decodable base64.
const decodeBase64Config = (value) => {
  let s = unescapeEntities(value).trim().replace(/-/g, '+').replace(/_/g, '/');
  s = s.replace(/=+$/, '');
  const mod = s.length % 4;
  if (mod === 1) { return null; }
  if (mod > 0) { s += '='.repeat(4 - mod); }
  try {
    return atob(s);
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
// no YAML/HTML-significant characters - sidesteps the crash, but the generator
// still HTML-escapes the base64 `=` padding (see decodeBase64Config). Local dev
// (fastly.toml) may still use raw JSON, so we try raw first, then base64-decode.
// Revert to raw JSON once SKYOPS-157895 ships; this parser keeps working either way.
export const parseSites = (env) => {
  const raw = env?.SITES ?? '{}';
  const result = tryJson(raw);
  if (result !== null) { return result; }
  const decoded = decodeBase64Config(raw);
  if (decoded !== null) {
    const fromB64 = tryJson(decoded);
    if (fromB64 !== null) { return fromB64; }
  }
  return {};
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
