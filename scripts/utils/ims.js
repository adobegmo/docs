import env from './env.js';

/*
 * Client-side IMS integration for the site chrome (profile menu). Adapted from
 * spectrum-hub scripts/utils/ims.js. Runs on proxied (authenticated) pages behind
 * the docket-auth edge worker:
 *   - loadIms(): sign-in state + profile (name/email) + avatar getter.
 *   - handleSignIn / handleSignOut: imslib redirects, plus the same-origin
 *     /auth/session POST (establish) / DELETE (clear) the worker's session cookie.
 *   - reconciliation: if IMS is signed out but a docket_session_active cookie
 *     lingers (e.g. you signed out of adobe.com elsewhere), tear the session down
 *     and reload into the login page.
 *
 * Differences from spectrum-hub: client_id is `adobegmo`; the readable companion
 * cookie is `docket_session_active`; setSession is a plain JSON POST (no CloudFront
 * SigV4 x-amz-content-sha256 header - our worker does not require it).
 */

const IMS_CLIENT_ID = 'adobegmo';
const IMS_SCOPES = 'AdobeID,openid';

// Set just before an explicit sign-in redirect so the return can reload once into
// the authenticated view. sessionStorage survives the IMS round-trip.
const SIGN_IN_RELOAD = 'docket-ims-signin-reload';
// One-shot per-tab guards for the two silent reconciliation reloads, keyed
// separately so establishing and tearing down never suppress each other.
const ESTABLISH_RELOAD = 'docket-ims-establish-reload';
const TEARDOWN_RELOAD = 'docket-ims-teardown-reload';

// How long before the stored expiry we start refreshing the session again.
const SESSION_REFRESH_WINDOW_MS = 60 * 60 * 1000;

const IMS_URL = 'https://auth.services.adobe.com/imslib/imslib.min.js';
const IMS_TIMEOUT = 5000;
const IMS_ENV = { dev: 'stg1', stage: 'stg1', prod: 'prod' };
const IO_ENV = {
  dev: 'cc-collab-stage.adobe.io',
  stage: 'cc-collab-stage.adobe.io',
  prod: 'cc-collab.adobe.io',
};

// The token params imslib puts in the return fragment. Strip them before a reload
// so location.reload() does not carry them into a page with no fresh IMS redirect.
const IMS_HASH_KEYS = ['access_token', 'token_type', 'expires_in'];

const reloadClean = () => {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (IMS_HASH_KEYS.some((key) => params.has(key))) {
    IMS_HASH_KEYS.forEach((key) => params.delete(key));
    const rest = params.toString();
    const url = window.location.pathname + window.location.search + (rest ? `#${rest}` : '');
    window.history.replaceState(null, '', url);
  }
  window.location.reload();
};

// Reload at most once per tab for a guard key, so a cookie/token desync can never
// become a reload loop.
const reloadOnce = (key) => {
  if (sessionStorage.getItem(key)) { return false; }
  sessionStorage.setItem(key, '1');
  reloadClean();
  return true;
};

// Presence of the readable companion cookie means a live server session exists;
// its value is the clamped expiry. Returns null when no session cookie is set.
export const readHintExpiry = () => {
  const match = document.cookie.match(/(?:^|;\s*)docket_session_active=([^;]+)/);
  const expiresAt = match ? Number(match[1]) : NaN;
  return Number.isFinite(expiresAt) ? expiresAt : null;
};

export function handleSignIn() {
  sessionStorage.setItem(SIGN_IN_RELOAD, '1');
  window.adobeIMS.signIn();
}

export async function handleSignOut() {
  // Clear the worker session first (both the HttpOnly cookie and its companion),
  // then redirect to IMS logout so the user is signed out of adobe.com too.
  await fetch('/auth/session', { method: 'DELETE', credentials: 'include' }).catch(() => {});
  window.adobeIMS.signOut();
}

async function loadScript(src) {
  return new Promise((resolve, reject) => {
    let script = document.querySelector(`head > script[src="${src}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = src;
      document.head.append(script);
    }
    if (!window.adobeIMS) {
      script.onload = resolve;
      script.onerror = reject;
    } else {
      resolve();
    }
  });
}

async function fetchWithToken(url, accessToken) {
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken.token}` } });
    if (!resp.ok) { return null; }
    return resp.json();
  } catch (e) {
    return null;
  }
}

// Lazy avatar/profile fetch from the collaboration API. Memoized per call site.
const getIoFactory = (accessToken) => {
  let io;
  return () => {
    io ??= fetchWithToken(`https://${IO_ENV[env]}/profile`, accessToken);
    return io;
  };
};

// No cookie, or one inside the refresh window, both mean "send the POST"; only a
// comfortably future cookie skips it.
export const dueForRefresh = () => {
  const expiresAt = readHintExpiry();
  if (expiresAt === null) { return true; }
  return Date.now() >= expiresAt - SESSION_REFRESH_WINDOW_MS;
};

// Establishes/refreshes the worker session cookie. Plain JSON POST; the worker
// validates the token server-side. Best-effort - a missing worker (e.g. local
// `aem up`) just 404s and returns false.
const setSession = async (accessToken) => {
  if (!dueForRefresh()) { return false; }
  try {
    const resp = await fetch('/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken.token }),
    });
    return resp.ok;
  } catch (e) {
    return false;
  }
};

async function loadDetails(accessToken) {
  const profile = await window.adobeIMS.getProfile();
  return { ...profile, accessToken, getIo: getIoFactory(accessToken) };
}

export const loadIms = (() => {
  let ims;

  const setup = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('IMS timeout')), IMS_TIMEOUT);

    window.adobeid = {
      client_id: IMS_CLIENT_ID,
      scope: IMS_SCOPES,
      locale: document.documentElement.lang?.replace('-', '_') || 'en_US',
      autoValidateToken: true,
      environment: IMS_ENV[env],
      useLocalStorage: true,
      onError: reject,
      onReady: async () => {
        const accessToken = window.adobeIMS.getAccessToken();
        if (accessToken) {
          const hadSession = readHintExpiry() !== null;
          const established = await setSession(accessToken);
          const pendingReload = sessionStorage.getItem(SIGN_IN_RELOAD);
          sessionStorage.removeItem(SIGN_IN_RELOAD);
          if (established && pendingReload) {
            clearTimeout(timeout);
            reloadClean();
            return;
          }
          if (established && !hadSession && reloadOnce(ESTABLISH_RELOAD)) {
            clearTimeout(timeout);
            return;
          }
          loadDetails(accessToken).then((details) => resolve(details));
        } else if (readHintExpiry() !== null) {
          // IMS signed out but the worker session lingers (e.g. signed out of
          // adobe.com elsewhere): tear it down and reload into the login page.
          await fetch('/auth/session', { method: 'DELETE', credentials: 'include' }).catch(() => {});
          if (reloadOnce(TEARDOWN_RELOAD)) {
            clearTimeout(timeout);
            return;
          }
          resolve({ anonymous: true });
        } else {
          resolve({ anonymous: true });
        }
        clearTimeout(timeout);
      },
    };
    loadScript(IMS_URL);
  });

  return () => {
    ims ??= setup();
    return ims;
  };
})();
