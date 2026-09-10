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

// Sensitive keys read asynchronously from secret_default.
const SECRET_KEYS = [
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

  // IMS_CLIENT_SECRET is stored base64-encoded: the Adobe CDN config generator
  // (SKYOPS-157895) mangles a secret value containing YAML/HTML-special characters
  // (& " { } : ...), which Adobe OAuth secrets commonly do, leaving it empty at
  // runtime. base64 has none of those, so it survives; we decode it back here.
  // SESSION_SECRET is our own hex, so it needs no encoding. Revert once the CLI
  // ships the fix. atob throws on a non-base64 value (e.g. a raw local secret),
  // in which case we leave it as-is.
  if (env.IMS_CLIENT_SECRET) {
    try { env.IMS_CLIENT_SECRET = atob(env.IMS_CLIENT_SECRET.trim()); } catch { /* leave raw */ }
  }

  return env;
};
