/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import { decodeJwt } from '../src/lib/jwt.js';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

describe('decodeJwt', () => {
  it('decodes header and payload, ignoring the signature', () => {
    const token = `${b64url({ alg: 'RS256' })}.${b64url({ created_at: '1785812270230', expires_in: '86400000' })}.sig`;
    const out = decodeJwt(token);
    assert.equal(out.header.alg, 'RS256');
    assert.equal(out.payload.created_at, '1785812270230');
    assert.equal(out.payload.expires_in, '86400000');
  });
  it('returns null when the segment count is wrong', () => {
    assert.equal(decodeJwt('only.two'), null);
    assert.equal(decodeJwt('a.b.c.d'), null);
  });
  it('returns null for non-string input', () => {
    assert.equal(decodeJwt(null), null);
    assert.equal(decodeJwt(undefined), null);
  });
  it('returns null when a segment is not valid JSON', () => {
    assert.equal(decodeJwt('bm90anNvbg.bm90anNvbg.sig'), null);
  });
});
