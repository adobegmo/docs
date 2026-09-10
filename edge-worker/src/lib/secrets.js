/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/// <reference types="@fastly/js-compute" />

/*
 * Secret store accessor, taken from the aem-edge-functions-boilerplate. In the
 * deployed environment secrets are bundled as JSON under a single "secrets"
 * key; local development (fastly.toml) exposes each secret under its own key.
 * This tries the bundle first, then falls back to per-key lookup.
 */

import { SecretStore } from 'fastly:secret-store';

export class SecretStoreManager {
  static instance = null;

  constructor() {
    this.store = null;
    this.secretsMap = null;
    this.secretsMapLoaded = false;
  }

  static getInstance() {
    if (!SecretStoreManager.instance) {
      SecretStoreManager.instance = new SecretStoreManager();
    }
    return SecretStoreManager.instance;
  }

  async getSecret(key) {
    if (!this.store) {
      this.store = new SecretStore('secret_default');
    }

    // Cloud format: all secrets bundled as JSON under the "secrets" key.
    if (!this.secretsMapLoaded) {
      this.secretsMapLoaded = true;
      try {
        const secretsEntry = await this.store.get('secrets');
        if (secretsEntry) {
          this.secretsMap = JSON.parse(secretsEntry.plaintext());
        }
      } catch {
        this.secretsMap = null;
      }
    }

    if (this.secretsMap && key in this.secretsMap) {
      return this.secretsMap[key];
    }

    // Fallback: fetch the secret individually (local development).
    const secret = await this.store.get(key);
    return secret ? secret.plaintext() : null;
  }

  static async getSecret(key) {
    const instance = SecretStoreManager.getInstance();
    return instance.getSecret(key);
  }

  // TEMP diagnostic: which keys the deployed secret bundle actually contains, and
  // whether an individual IMS_CLIENT_SECRET entry exists. Keys only, no values.
  static async debugInfo() {
    const instance = SecretStoreManager.getInstance();
    if (!instance.store) { instance.store = new SecretStore('secret_default'); }
    let bundleKeys = '<no-bundle>';
    try {
      const entry = await instance.store.get('secrets');
      if (entry) { bundleKeys = Object.keys(JSON.parse(entry.plaintext())).join('|'); }
    } catch {
      bundleKeys = '<bundle-error>';
    }
    let individual = false;
    try {
      individual = !!(await instance.store.get('IMS_CLIENT_SECRET'));
    } catch {
      individual = false;
    }
    return `bundle=[${bundleKeys}] individualImsSecret=${individual}`;
  }
}
