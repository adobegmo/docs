/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/// <reference types="@fastly/js-compute" />

/*
 * The self-contained login screen the edge function returns for any request
 * without a valid session. It loads Adobe imslib, signs the user in against IMS,
 * then POSTs the access token to /auth/session; on success the page reloads and
 * the (now authenticated) request is proxied to the real site. A 403 from
 * /auth/session means signed-in-but-not-on-the-allowlist.
 *
 * The page is self-contained (inline script + imslib from Adobe's CDN) because
 * every site asset is gated too - the login page cannot import site JS/CSS.
 */

import { imslibEnvironment } from './lib/sites.js';

const IMS_URL = 'https://auth.services.adobe.com/imslib/imslib.min.js';
const IMS_SCOPES = 'AdobeID,openid';

// The client-side script, as a template. Only the client id and imslib
// environment are interpolated - both from trusted server config, never the
// request, so there is no user input to escape.
const clientScript = (clientId, environment) => `
  const NOT_AUTHORIZED = 'notauth';
  const showSignIn = () => { document.getElementById('signin').hidden = false; };
  const showMessage = (kind, text) => {
    const el = document.getElementById('status');
    el.className = 'status ' + kind;
    el.textContent = text;
    el.hidden = false;
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
        // Reload without the IMS token fragment so it does not linger in history;
        // the reload is now served the proxied site (the cookie is set).
        window.location.replace(window.location.pathname + window.location.search);
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

  window.adobeid = {
    client_id: '${clientId}',
    scope: '${IMS_SCOPES}',
    locale: 'en_US',
    // imslib validates the token via /ims/check (cross-origin), which the IMS
    // client's CORS allowlist now permits. The worker also validates the token
    // server-side in /auth/session, so this is defense in depth.
    autoValidateToken: true,
    environment: '${environment}',
    useLocalStorage: true,
    onError: () => { showSignIn(); },
    onReady: () => {
      // A token here means either a fresh sign-in return OR a silent re-auth for a
      // user already signed in to IMS - both establish the session with no click.
      const accessToken = window.adobeIMS && window.adobeIMS.getAccessToken();
      if (accessToken && accessToken.token) {
        establishSession(accessToken.token);
      } else {
        showSignIn();
      }
    },
  };

  document.getElementById('signin').addEventListener('click', () => {
    window.adobeIMS.signIn();
  });
  document.getElementById('switch').addEventListener('click', () => {
    window.adobeIMS.signOut({ redirect_uri: window.location.href });
  });

  // imslib reads window.adobeid on load, so append it only after the config above
  // is in place - hence a dynamic script rather than a static tag.
  const imslib = document.createElement('script');
  imslib.src = '${IMS_URL}';
  imslib.onerror = () => showSignIn();
  document.head.appendChild(imslib);
`;

export const renderLoginPage = (env, status = 401) => {
  const clientId = env.IMS_CLIENT_ID_PUBLIC || '';
  const environment = imslibEnvironment(env.IMS_ENV);

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
  <script>${clientScript(clientId, environment)}</script>
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
