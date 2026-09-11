/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/// <reference types="@fastly/js-compute" />

/*
 * Builds a plain env object from the Fastly config store (non-sensitive values,
 * declared in config/edgeFunctions.yaml) and secret store (secrets, declared as
 * Cloud Manager secret references). The rest of the worker reads this object the
 * same way the Lambda read process.env, so handlers/lib stay platform-agnostic.
 * Per-site resolution lives in sites.js and reads env.SITES.
 */

import { ConfigStore } from 'fastly:config-store';
import { SecretStoreManager } from './secrets.js';

// Non-sensitive keys read synchronously from config_default.
const CONFIG_KEYS = [
  'SITES', // JSON map: { "<host>": { "org", "site", "hostSuffix"? } } - see sites.js
  'AEM_HOST_SUFFIX', // default AEM tier suffix when a SITES entry omits hostSuffix
  'IMS_ENV',
  'IMS_CLIENT_ID', // confidential service identity (paired with the secret below)
  'IMS_CLIENT_ID_PUBLIC', // public browser OAuth client id (used client-side + profile call)
  'IMS_SCOPE',
  'SESSION_MAX_AGE_MS',
];

// Sensitive keys read asynchronously from secret_default. APP_SECRETS is a
// base64-encoded JSON bundle of the real secrets (see below); the individual keys
// are still read for local dev (fastly.toml) and as a fallback.
const SECRET_KEYS = [
  'APP_SECRETS',
  'SESSION_SECRET',
  'IMS_CLIENT_SECRET',
  'ORIGIN_AUTHENTICATION',
];

export const loadEnv = async () => {
  const env = {};

  let store;
  try {
    store = new ConfigStore('config_default');
  } catch {
    store = null;
  }
  for (const key of CONFIG_KEYS) {
    const value = store ? store.get(key) : null;
    if (value != null && value !== '') { env[key] = value; }
  }

  await Promise.all(SECRET_KEYS.map(async (key) => {
    let value = null;
    try {
      value = await SecretStoreManager.getSecret(key);
    } catch {
      value = null;
    }
    if (value != null && value !== '') { env[key] = value; }
  }));

  // WORKAROUND: a SECOND ${{...}} secret variable resolves EMPTY in the Adobe CDN
  // config generator (confirmed: DOCKET_IMS_CLIENT_SECRET, set non-empty, comes
  // back empty in the secret bundle, while DOCKET_SESSION_SECRET resolves fine).
  // So both real secrets are packed into the ONE working variable as a base64 JSON
  // bundle: ${{DOCKET_SESSION_SECRET}} -> APP_SECRETS. base64 also sidesteps the
  // SKYOPS-157895 special-character mangling. We unpack it over the individual keys
  // here. Local dev sets the individual secrets directly, so this no-ops there.
  // Revert to separate secret variables once the pipeline bug is fixed.
  if (env.APP_SECRETS) {
    try {
      const bundle = JSON.parse(atob(env.APP_SECRETS.trim()));
      for (const key of ['SESSION_SECRET', 'IMS_CLIENT_SECRET']) {
        if (typeof bundle[key] === 'string' && bundle[key] !== '') { env[key] = bundle[key]; }
      }
    } catch { /* leave individual values in place */ }
  }

  return env;
};
