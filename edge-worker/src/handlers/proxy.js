/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/// <reference types="@fastly/js-compute" />

/*
 * Authenticated passthrough to the AEM Edge Delivery origin. This is the whole
 * "you are allowed in" path: an authenticated visitor's request is forwarded to
 * main--<site>--<org>.<suffix> verbatim and the response returned as-is. Ported
 * from the formatRequest/fetchFromAem portion of spectrum-hub website-lambda,
 * minus the per-viewer audience/query-index filtering (this site is all-or-nothing).
 */

// Builds the upstream request pointed at the resolved site's AEM origin.
const formatRequest = (request, url, env, site) => {
  const aemUrl = new URL(url.href);
  aemUrl.hostname = `main--${site.site}--${site.org}.${site.hostSuffix}`;
  aemUrl.port = '';
  aemUrl.protocol = 'https:';

  const req = new Request(aemUrl, request);

  // x-forwarded-host tells aem.live/aem.page the public hostname (for absolute
  // URLs, redirects, sitemaps) - the resolved public host (site.host), not
  // url.host, which behind the CDN may be an internal host.
  req.headers.set('x-forwarded-host', site.host);

  // The session cookie is the worker's own credential; no upstream needs any
  // browser cookie, so drop the whole header rather than leak docket_session.
  req.headers.delete('cookie');

  // aem.live keys push-invalidation and forwarded-header handling off this value.
  req.headers.set('x-byo-cdn-type', 'fastly');

  // Only authenticated requests reach this point, so the origin credential (when
  // the aem.live origin requires one) is attached to what gets proxied upstream.
  if (env.ORIGIN_AUTHENTICATION) {
    req.headers.set('authorization', `token ${env.ORIGIN_AUTHENTICATION}`);
  }
  return req;
};

export const proxyToAem = async ({ request, url, env, site }) => {
  if (!site) {
    return new Response('Unknown site', {
      status: 404,
      headers: { 'cache-control': 'no-store' },
    });
  }

  const upstream = formatRequest(request, url, env, site);
  let resp = await fetch(upstream, { cache: 'no-store' });

  // Recreate a mutable response so we can adjust headers.
  resp = new Response(resp.body, resp);
  if (resp.status === 304) { resp.headers.delete('Content-Security-Policy'); }
  resp.headers.delete('age');
  resp.headers.delete('x-robots-tag');
  return resp;
};
