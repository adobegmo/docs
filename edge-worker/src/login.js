/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/// <reference types="@fastly/js-compute" />

/*
 * The self-contained login screen the edge function returns for any request
 * without a valid session.
 *
 * It runs the Adobe IMS OAuth *implicit* flow WITHOUT imslib: a full-page
 * redirect to /ims/authorize/v2 (response_type=token) and reading the returned
 * access token from our own URL fragment. Both are same-origin operations, so -
 * unlike imslib, which makes cross-origin XHRs to /ims/check that require the
 * origin to be on the client's CORS allowlist - this needs only a registered
 * redirect_uri. The token is then POSTed to /auth/session, where the worker
 * validates it server-side (the real security boundary) and mints the cookie.
 */

const IMS_SCOPES = 'AdobeID,openid';

// Authorize endpoint host per IMS environment.
const IMS_HOST = {
  dev: 'https://ims-na1-stg1.adobelogin.com',
  stage: 'https://ims-na1-stg1.adobelogin.com',
  prod: 'https://ims-na1.adobelogin.com',
};

// The client-side script, as a template. Only the client id and IMS host are
// interpolated - both from trusted server config, never from the request.
const clientScript = (clientId, imsHost) => `
  const NOT_AUTHORIZED = 'notauth';
  const SCOPES = '${IMS_SCOPES}';
  const CLIENT_ID = '${clientId}';
  const IMS_HOST = '${imsHost}';
  const STATE_KEY = 'docket-oauth-state';
  const RETURN_KEY = 'docket-return-to';

  const showSignIn = () => { document.getElementById('signin').hidden = false; };
  const showMessage = (kind, text) => {
    const el = document.getElementById('status');
    el.className = 'status ' + kind;
    el.textContent = text;
    el.hidden = false;
  };

  const randomState = () => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  // Full-page redirect to IMS (implicit grant). A navigation is not a CORS
  // request, so this needs only a registered redirect_uri - no allowed-origins on
  // the client. 'prompt' lets the "different account" button force re-auth.
  const signIn = (prompt) => {
    const state = randomState();
    sessionStorage.setItem(STATE_KEY, state);
    sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPES,
      response_type: 'token',
      redirect_uri: window.location.origin + '/',
      locale: 'en_US',
      state,
    });
    if (prompt) { params.set('prompt', prompt); }
    window.location.assign(IMS_HOST + '/ims/authorize/v2?' + params.toString());
  };

  async function establishSession(token) {
    try {
      const resp = await fetch('/auth/session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_token: token }),
      });
      if (resp.status === 200) {
        const back = sessionStorage.getItem(RETURN_KEY) || '/';
        sessionStorage.removeItem(RETURN_KEY);
        window.location.replace(back);
        return;
      }
      if (resp.status === 403) {
        showMessage(NOT_AUTHORIZED, 'This account is not authorized to view this site. Ask the site owner to add you, or sign in with a different account.');
        document.getElementById('switch').hidden = false;
        return;
      }
      showMessage('error', 'Sign-in could not be completed. Please try again later.');
    } catch (e) {
      showMessage('error', 'Sign-in could not be completed. Please try again later.');
    }
  }

  document.getElementById('signin').addEventListener('click', () => signIn());
  document.getElementById('switch').addEventListener('click', () => signIn('select_account'));

  // On return from IMS the token is in the URL fragment. Reading our own hash and
  // POSTing to our own /auth/session are same-origin - no CORS, no imslib.
  (function handleReturn() {
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const frag = new URLSearchParams(hash);
    if (frag.get('error')) {
      showMessage('error', 'Sign-in was cancelled or failed. Please try again.');
      showSignIn();
      return;
    }
    const token = frag.get('access_token');
    if (!token) { showSignIn(); return; }
    const returnedState = frag.get('state');
    const expected = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
    // Strip the token from the URL immediately (out of the address bar/history).
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!expected || returnedState !== expected) {
      showMessage('error', 'Sign-in could not be verified. Please try again.');
      showSignIn();
      return;
    }
    establishSession(token);
  }());
`;

export const renderLoginPage = (env, status = 401) => {
  const clientId = env.IMS_CLIENT_ID_PUBLIC || '';
  const imsHost = IMS_HOST[env.IMS_ENV] ?? IMS_HOST.prod;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f5f5f5; color: #1a1a1a; padding: 24px;
  }
  .card {
    width: 100%; max-width: 380px; background: #fff; border: 1px solid #e1e1e1; border-radius: 12px;
    padding: 40px 32px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,.06);
  }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p.lead { margin: 0 0 28px; color: #6e6e6e; font-size: 14px; line-height: 1.5; }
  button {
    font: inherit; font-weight: 600; cursor: pointer; border-radius: 8px; padding: 12px 20px;
    width: 100%; border: 1px solid transparent;
  }
  #signin { background: #1473e6; color: #fff; }
  #signin:hover { background: #0d66d0; }
  #switch { background: transparent; color: #1473e6; border-color: #1473e6; margin-top: 12px; }
  .status { margin: 0 0 20px; font-size: 14px; line-height: 1.5; border-radius: 8px; padding: 12px 14px; }
  .status.notauth { background: #fbeae7; color: #b7373b; }
  .status.error { background: #fbeae7; color: #b7373b; }
  [hidden] { display: none; }
  @media (prefers-color-scheme: dark) {
    body { background: #1d1d1d; color: #f5f5f5; }
    .card { background: #252525; border-color: #3a3a3a; }
    p.lead { color: #a9a9a9; }
  }
</style>
</head>
<body>
  <main class="card">
    <h1>Sign in required</h1>
    <p class="lead">This site is private. Sign in with your Adobe account to continue.</p>
    <p id="status" class="status" hidden></p>
    <button id="signin" type="button" hidden>Sign in</button>
    <button id="switch" type="button" hidden>Sign in with a different account</button>
  </main>
  <script>${clientScript(clientId, imsHost)}</script>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};
