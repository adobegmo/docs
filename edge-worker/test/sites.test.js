/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import { parseSites, resolveSite, isKnownOriginHost, imslibEnvironment } from '../src/lib/sites.js';

const SITES = JSON.stringify({
  'preview.red.adobe.com': { org: 'adobegmo', site: 'red' },
  'preview.blue.adobe.com': { org: 'adobegmo', site: 'blue', hostSuffix: 'aem.live' },
});
const env = { SITES, AEM_HOST_SUFFIX: 'aem.page' };

describe('parseSites', () => {
  it('parses a valid map', () => {
    assert.equal(Object.keys(parseSites(env)).length, 2);
  });
  it('returns an empty map for missing / malformed / array values (fail closed)', () => {
    assert.deepEqual(parseSites({}), {});
    assert.deepEqual(parseSites({ SITES: 'not json' }), {});
    assert.deepEqual(parseSites({ SITES: '[1,2]' }), {});
  });
});

describe('resolveSite', () => {
  it('resolves a known host to its org/site with the default suffix', () => {
    assert.deepEqual(resolveSite(env, 'preview.red.adobe.com'), { host: 'preview.red.adobe.com', org: 'adobegmo', site: 'red', hostSuffix: 'aem.page' });
  });
  it('honors a per-entry hostSuffix override', () => {
    assert.equal(resolveSite(env, 'preview.blue.adobe.com').hostSuffix, 'aem.live');
  });
  it('is case-insensitive on the host', () => {
    assert.equal(resolveSite(env, 'Preview.Red.Adobe.Com').site, 'red');
  });
  it('falls back to aem.live when no suffix is configured anywhere', () => {
    assert.equal(resolveSite({ SITES }, 'preview.red.adobe.com').hostSuffix, 'aem.live');
  });
  it('returns null for an unconfigured host', () => {
    assert.equal(resolveSite(env, 'evil.example.com'), null);
    assert.equal(resolveSite(env, ''), null);
    assert.equal(resolveSite(env, undefined), null);
  });
  it('returns null when an entry is missing org or site', () => {
    const bad = { SITES: JSON.stringify({ 'a.com': { org: 'x' } }) };
    assert.equal(resolveSite(bad, 'a.com'), null);
  });
});

describe('isKnownOriginHost', () => {
  it('accepts an Origin whose host is a configured site', () => {
    assert.equal(isKnownOriginHost(env, 'https://preview.red.adobe.com'), true);
  });
  it('rejects an unknown or missing Origin', () => {
    assert.equal(isKnownOriginHost(env, 'https://evil.example.com'), false);
    assert.equal(isKnownOriginHost(env, ''), false);
    assert.equal(isKnownOriginHost(env, null), false);
    assert.equal(isKnownOriginHost(env, 'not a url'), false);
  });
});

describe('imslibEnvironment', () => {
  it('maps prod to prod and everything else to stg1', () => {
    assert.equal(imslibEnvironment('prod'), 'prod');
    assert.equal(imslibEnvironment('stage'), 'stg1');
    assert.equal(imslibEnvironment(undefined), 'stg1');
  });
});
