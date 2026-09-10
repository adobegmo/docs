/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/// <reference types="@fastly/js-compute" />

/*
 * Site authentication edge function (Fastly Compute). Every request routed here
 * (see config/cdn.yaml) is either:
 *   - the /auth/session credential endpoint (never proxied), or
 *   - any other path, gated all-or-nothing on the docket_session cookie:
 *       valid session  -> proxy the request to the AEM origin (full access)
 *       no/invalid one -> return the login page (401), nothing fetched upstream.
 */

import { loadEnv } from './lib/env.js';
import { resolveSite, parseSites } from './lib/sites.js';
import { readSession, DEFAULT_SESSION_COOKIE_NAME } from './lib/session.js';
import { createSession, deleteSession } from './handlers/auth.js';
import { proxyToAem } from './handlers/proxy.js';
import { renderLoginPage } from './login.js';

// A Map, not an object literal: the key is a request path, and a plain object
// would resolve '/auth/constructor'-shaped lookups off the prototype.
const AUTH_ENDPOINTS = new Map([
  ['/auth/session', { POST: createSession, DELETE: deleteSession }],
]);

const isAuthPath = (path) => path === '/auth' || path.startsWith('/auth/');

const notFound = () => new Response('Not found', {
  status: 404,
  headers: { 'cache-control': 'no-store' },
});

const methodNotAllowed = (methods) => new Response('Method Not Allowed', {
  status: 405,
  headers: { allow: methods.join(', '), 'cache-control': 'no-store' },
});

// The whole /auth/ namespace is claimed here so nothing under it can ever reach
// the AEM proxy (which would forward the IMS access token in the body upstream).
// A path that is not an exact match for a known endpoint is a 404, not a proxy.
const handleAuth = (context) => {
  const handlers = AUTH_ENDPOINTS.get(context.url.pathname);
  if (!handlers) { return notFound(); }
  const { method } = context.request;
  const handler = Object.prototype.hasOwnProperty.call(handlers, method)
    ? handlers[method]
    : undefined;
  return handler ? handler(context) : methodNotAllowed(Object.keys(handlers));
};

// Pulls one named value out of the Cookie header. Cookie values here are
// base64url, so a split on the first '=' recovers the value intact.
const readCookie = (request, name) => {
  const header = request.headers.get('cookie');
  if (!header) { return null; }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) { continue; }
    if (part.slice(0, eq).trim() === name) { return part.slice(eq + 1).trim(); }
  }
  return null;
};

// A valid session cookie means an authenticated caller. Verification is local
// (HMAC + expiry) - no store, no network - so it is cheap to run per request.
const isAuthenticated = async (request, env) => {
  if (!env.SESSION_SECRET) { return false; }
  const cookie = readCookie(request, DEFAULT_SESSION_COOKIE_NAME);
  if (!cookie) { return false; }
  return (await readSession(cookie, env.SESSION_SECRET, Date.now())) !== null;
};

// The public host can arrive in x-forwarded-host (set by the Adobe CDN in front
// of the edge function) rather than the request URL - behind a CDN the URL's own
// host is often an internal one. Try each candidate against SITES and use the
// first that maps, so resolution works regardless of which one carries it.
const resolveSiteFromRequest = (env, request, url) => {
  const candidates = [
    (request.headers.get('x-forwarded-host') || '').split(',')[0].trim(),
    request.headers.get('host') || '',
    url.host,
  ];
  for (const host of candidates) {
    const site = resolveSite(env, host);
    if (site) { return site; }
  }
  return null;
};

async function handleRequest(event) {
  const { request } = event;
  const url = new URL(request.url);

  let env;
  try {
    env = await loadEnv();
    // Resolve which site this request targets from its host (repoless: one code
    // base, many sites). Threaded into the auth + proxy handlers.
    const site = resolveSiteFromRequest(env, request, url);
    // TEMP DIAGNOSTIC (remove once resolution is confirmed): shows which host
    // candidate matched (or none) and whether SITES decoded. No secrets logged.
    console.log(JSON.stringify({
      msg: 'site-resolve',
      matched: site ? site.host : null,
      urlHost: url.host,
      xForwardedHost: request.headers.get('x-forwarded-host'),
      hostHeader: request.headers.get('host'),
      siteKeys: Object.keys(parseSites(env)),
      // presence only (never the values) - shows which env var is empty at runtime
      present: {
        SESSION_SECRET: !!env.SESSION_SECRET,
        IMS_CLIENT_ID: !!env.IMS_CLIENT_ID,
        IMS_CLIENT_SECRET: !!env.IMS_CLIENT_SECRET,
        IMS_SCOPE: !!env.IMS_SCOPE,
        IMS_CLIENT_ID_PUBLIC: !!env.IMS_CLIENT_ID_PUBLIC,
      },
    }));

    if (isAuthPath(url.pathname)) {
      return await handleAuth({ url, env, request, site });
    }

    if (site && await isAuthenticated(request, env)) {
      return await proxyToAem({ request, url, env, site });
    }

    // Anonymous (or an unconfigured host): the login screen for every path.
    // Nothing upstream is fetched, so no site content can leak.
    return renderLoginPage(env, 401);
  } catch (err) {
    console.log(err);
    // Fail closed: any unexpected error becomes the login page, never origin
    // content. env may be undefined if loadEnv itself threw.
    return renderLoginPage(env || {}, 401);
  }
}

addEventListener('fetch', (event) => event.respondWith(handleRequest(event)));
