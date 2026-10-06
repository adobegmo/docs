/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import { originTokenFor, parseOriginTokenMap } from '../src/lib/origin-auth.js';

const red = { host: 'red.adobe.com', org: 'adobegmo', site: 'red', hostSuffix: 'aem.live' };
const writing = { host: 'writing.adobe.com', org: 'adobegmo', site: 'writing', hostSuffix: 'aem.live' };

describe('parseOriginTokenMap', () => {
  it('keeps non-empty string tokens only', () => {
    assert.deepEqual(
      parseOriginTokenMap({ red: 'hlx_r', writing: '', blue: 42 }),
      { red: 'hlx_r' },
    );
  });
  it('returns null for non-object values', () => {
    assert.equal(parseOriginTokenMap(undefined), null);
    assert.equal(parseOriginTokenMap('hlx_x'), null);
    assert.equal(parseOriginTokenMap(['hlx_x']), null);
  });
});

describe('originTokenFor', () => {
  it('uses the single ORIGIN_AUTHENTICATION when no per-site map is set', () => {
    assert.equal(originTokenFor({ ORIGIN_AUTHENTICATION: 'hlx_one' }, red), 'hlx_one');
  });
  it('returns empty when nothing is configured', () => {
    assert.equal(originTokenFor({}, red), '');
  });
  it('picks each site its own token from the per-site map', () => {
    const env = { ORIGIN_AUTHENTICATION_BY_SITE: { red: 'hlx_r', writing: 'hlx_w' } };
    assert.equal(originTokenFor(env, red), 'hlx_r');
    assert.equal(originTokenFor(env, writing), 'hlx_w');
  });
  it('never falls back to another token when the map lacks the site', () => {
    const env = {
      ORIGIN_AUTHENTICATION: 'hlx_single',
      ORIGIN_AUTHENTICATION_BY_SITE: { red: 'hlx_r' },
    };
    assert.equal(originTokenFor(env, writing), '');
  });
  it('returns empty for a missing site', () => {
    assert.equal(originTokenFor({ ORIGIN_AUTHENTICATION_BY_SITE: { red: 'hlx_r' } }, null), '');
  });
});
