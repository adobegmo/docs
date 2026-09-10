/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/// <reference types="@fastly/js-compute" />

/*
 * The /auth/session endpoint: POST establishes a server session, DELETE clears
 * it. Ported from spectrum-hub website-lambda handlers/auth.js, trimmed for the
 * Fastly edge function: config comes from the env object (loadEnv) instead of
 * process.env, and the CloudFront-OAC-specific x-amz-content-sha256 payload
 * hash is gone (the client POST is a plain JSON fetch).
 */

import {
  createSessionCookies,
  serializeCookie,
  durationMs,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_SESSION_COOKIE_NAME,
  DEFAULT_SESSION_HINT_COOKIE_NAME,
} from '../lib/session.js';
import { decodeJwt } from '../lib/jwt.js';
import { isVisitorAllowed } from '../lib/allowlist.js';
import { isKnownOriginHost } from '../lib/sites.js';

const IMS_PROFILE_URL = {
  dev: 'https://ims-na1-stg1.adobelogin.com/ims/profile/v1',
  stage: 'https://ims-na1-stg1.adobelogin.com/ims/profile/v1',
  prod: 'https://ims-na1.adobelogin.com/ims/profile/v1',
};

// client_credentials endpoint for the DA service token.
const IMS_TOKEN_URL = {
  dev: 'https://ims-na1-stg1.adobelogin.com/ims/token/v3',
  stage: 'https://ims-na1-stg1.adobelogin.com/ims/token/v3',
  prod: 'https://ims-na1.adobelogin.com/ims/token/v3',
};

// Where the visitor allowlist lives. admin.da.live keys config by org/site,
// resolved per request from the host (see sites.js) so one repoless code base
// can gate many sites, each with its own visitors list.
const daConfigUrl = (site) => `https://admin.da.live/config/${site.org}/${site.site}/`;

const configFromEnv = (env, url) => ({
  secret: env.SESSION_SECRET,
  maxAgeMs: durationMs(env.SESSION_MAX_AGE_MS, DEFAULT_MAX_AGE_MS),
  sessionCookieName: DEFAULT_SESSION_COOKIE_NAME,
  secure: url.protocol === 'https:',
});

// Blunts session fixation, where an attacker makes a victim's browser adopt an
// attacker-controlled session. The set of configured site hosts IS the origin
// allowlist: a request must come from one of them. Fail closed - an unknown or
// missing Origin is refused.
const isAllowedOrigin = (request, env) => {
  const origin = request.headers.get('origin');
  return isKnownOriginHost(env, origin);
};

// no-store: this endpoint mints credentials and sits behind a CDN.
const problem = (status, message) => new Response(message, {
  status,
  headers: {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  },
});

// Lets IMS itself decide whether the token is real, instead of checking a
// signature locally: a 401/403 here means IMS rejected it. Anything else non-2xx
// is IMS having a problem, not proof of a forged token, so it is surfaced
// separately (see the try/catch at the call site).
const fetchImsProfile = async (token, imsEnv, clientId) => {
  const base = IMS_PROFILE_URL[imsEnv] ?? IMS_PROFILE_URL.prod;
  const resp = await fetch(`${base}?client_id=${clientId}`, { headers: { authorization: `Bearer ${token}` } });
  if (resp.status === 401 || resp.status === 403) { return { rejected: true }; }
  if (!resp.ok) { throw new Error(`IMS profile request failed with status ${resp.status}`); }
  return { rejected: false, profile: await resp.json() };
};

// A client_credentials token for this worker's own service identity - not the
// visitor's token. It authorizes the DA config read below and is never stored
// or handed back to the client.
const fetchServiceToken = async (env, imsEnv) => {
  const url = IMS_TOKEN_URL[imsEnv] ?? IMS_TOKEN_URL.prod;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.IMS_CLIENT_ID,
      client_secret: env.IMS_CLIENT_SECRET,
      scope: (env.IMS_SCOPE ?? '').replace(/\s+/g, ''),
    }),
  });
  if (!resp.ok) { throw new Error(`IMS token request failed with status ${resp.status}`); }
  const token = (await resp.json())?.access_token;
  if (typeof token !== 'string' || token === '') {
    throw new Error('IMS token response carried no access_token');
  }
  return token;
};

// Reads the DA config with a freshly minted service token and returns the raw
// visitor rows (visitors.data). A throw here means "could not decide" - the
// caller must fail closed, never mint a cookie on an unresolved check.
const fetchVisitorAllowlist = async (env, imsEnv, site) => {
  const token = await fetchServiceToken(env, imsEnv);
  const resp = await fetch(daConfigUrl(site), { headers: { authorization: `Bearer ${token}` } });
  if (!resp.ok) { throw new Error(`DA config request failed with status ${resp.status}`); }
  const rows = (await resp.json())?.visitors?.data;
  return Array.isArray(rows) ? rows : [];
};

export const createSession = async ({ url, env, request, site }) => {
  if (request.method !== 'POST') {
    const resp = problem(405, 'Method Not Allowed');
    resp.headers.set('allow', 'POST');
    return resp;
  }

  if (!isAllowedOrigin(request, env)) {
    return problem(403, 'Forbidden');
  }

  // The request host must map to a configured site; its allowlist is what we
  // check the email against. An unconfigured host can never mint a session.
  if (!site) {
    return problem(403, 'Unknown site');
  }

  if (!env.SESSION_SECRET) {
    return problem(500, 'Session signing is not configured');
  }

  // The service credential is required to read the visitor allowlist. A missing
  // one is a deploy mistake, not a caller error - surface it as 500 rather than
  // letting it collapse into the 502 "DA unreachable" path.
  if (!env.IMS_CLIENT_ID || !env.IMS_CLIENT_SECRET || !env.IMS_SCOPE) {
    return problem(500, 'Visitor authorization is not configured');
  }

  if (!env.IMS_CLIENT_ID_PUBLIC) {
    return problem(500, 'IMS sign-in is not configured');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return problem(400, 'Request body must be valid JSON');
  }

  const token = body?.access_token;
  if (typeof token !== 'string' || token === '') {
    return problem(400, 'access_token is required');
  }

  // Verify the caller's token against IMS first, before spending a service token
  // on the DA lookup. The DA read is deliberately gated behind a successful
  // profile call so IMS acts as the rate limiter: an invalid or spoofed token
  // never reaches DA, no matter how often it is retried.
  const imsEnv = env.IMS_ENV ?? 'prod';
  let outcome;
  try {
    outcome = await fetchImsProfile(token, imsEnv, env.IMS_CLIENT_ID_PUBLIC);
  } catch {
    return problem(502, 'Unable to verify access_token against IMS');
  }
  if (outcome.rejected) {
    return problem(401, 'access_token was rejected by IMS');
  }

  // created_at/expires_in are the JWT's own claims, read without checking a
  // signature - safe here specifically because IMS's 200 above already vouched
  // for this exact token. email comes from the profile response: the one thing
  // the JWT never carries, and the reason this worker asks IMS at all.
  const email = outcome.profile?.email;
  const decoded = decodeJwt(token);
  if (typeof email !== 'string' || email === '' || !decoded) {
    return problem(502, 'IMS returned a token or profile this worker could not use');
  }

  // Authorization, distinct from the authentication above: IMS proved who this
  // is, DA decides whether they may in. Fail closed - a cookie is only ever
  // minted for an email (or its domain) present in the allowlist, and an
  // unreachable DA is a 502, never an admit.
  let allowlist;
  try {
    allowlist = await fetchVisitorAllowlist(env, imsEnv, site);
  } catch {
    return problem(502, 'Unable to verify access against DA');
  }
  if (!isVisitorAllowed(email, allowlist)) {
    return problem(403, 'Not authorized');
  }

  const claims = {
    email,
    created_at: decoded.payload?.created_at,
    expires_in: decoded.payload?.expires_in,
  };

  const result = await createSessionCookies({
    body: { token: JSON.stringify(claims), ...claims },
    now: Date.now(),
    config: configFromEnv(env, url),
  });

  if (result.error) {
    return problem(result.error.status, result.error.message);
  }

  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  for (const cookie of result.cookies) { headers.append('set-cookie', cookie); }
  return new Response(JSON.stringify({ expiresAt: result.expiresAt }), { status: 200, headers });
};

// The counterpart to createSession: clears the cookie in the caller's browser.
// There is no server-side session store, so it does not revoke the underlying
// credential (rotating SESSION_SECRET is the only lever that does).
export const deleteSession = async ({ url, env, request }) => {
  if (request.method !== 'DELETE') {
    const resp = problem(405, 'Method Not Allowed');
    resp.headers.set('allow', 'DELETE');
    return resp;
  }

  if (!isAllowedOrigin(request, env)) {
    return problem(403, 'Forbidden');
  }

  // Path and SameSite must match the cookie createSession set, or the browser
  // treats this as an unrelated cookie and never clears the real one.
  const secure = url.protocol === 'https:';
  const cookie = serializeCookie(DEFAULT_SESSION_COOKIE_NAME, '', {
    maxAgeSeconds: 0,
    httpOnly: true,
    secure,
  });
  const hintCookie = serializeCookie(DEFAULT_SESSION_HINT_COOKIE_NAME, '', {
    maxAgeSeconds: 0,
    httpOnly: false,
    secure,
  });

  const headers = new Headers({ 'cache-control': 'no-store' });
  headers.append('set-cookie', cookie);
  headers.append('set-cookie', hintCookie);
  return new Response(null, { status: 204, headers });
};
