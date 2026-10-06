/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/*
 * Pure selection of the AEM origin token (token-based Site Authentication) for a
 * resolved site. Each AEM site has its OWN hlx_ token, and one Cloud Manager
 * program can front several sites (e.g. prod red + writing in one program), so a
 * single ORIGIN_AUTHENTICATION is not enough there. The secret bundle may instead
 * carry ORIGIN_AUTHENTICATION_BY_SITE: { "<site>": "hlx_..." }, keyed by the
 * SITES entry's `site` name.
 */

// Keeps only non-empty string values from a { site: token } object; anything
// else yields null so callers can tell "no map" from "map without this site".
export const parseOriginTokenMap = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return null; }
  const map = {};
  for (const [site, token] of Object.entries(value)) {
    if (typeof token === 'string' && token !== '') { map[site] = token; }
  }
  return map;
};

// Returns the token to send to this site's origin, or '' for none. When a
// per-site map is configured it is authoritative: a site missing from it gets no
// token rather than falling back to the single ORIGIN_AUTHENTICATION, so one
// site's token is never sent to another site's origin.
export const originTokenFor = (env, site) => {
  const map = env?.ORIGIN_AUTHENTICATION_BY_SITE;
  if (map && typeof map === 'object') {
    const token = site?.site ? map[site.site] : undefined;
    return typeof token === 'string' ? token : '';
  }
  return typeof env?.ORIGIN_AUTHENTICATION === 'string' ? env.ORIGIN_AUTHENTICATION : '';
};
