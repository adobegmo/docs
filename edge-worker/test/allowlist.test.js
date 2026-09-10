/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import { isVisitorAllowed } from '../src/lib/allowlist.js';

const rows = (...emails) => emails.map((email) => ({ email }));

describe('isVisitorAllowed', () => {
  it('admits an exact email match (case-insensitive, trimmed)', () => {
    assert.equal(isVisitorAllowed('Jane@Example.com', rows('jane@example.com')), true);
    assert.equal(isVisitorAllowed('  jane@example.com  ', rows(' JANE@EXAMPLE.COM ')), true);
  });
  it('admits any address in a leading-@ domain wildcard', () => {
    assert.equal(isVisitorAllowed('anyone@adobe.com', rows('@adobe.com')), true);
    assert.equal(isVisitorAllowed('someone.else@ADOBE.com', rows('@adobe.com')), true);
  });
  it('does not treat a domain wildcard as an exact address', () => {
    assert.equal(isVisitorAllowed('adobe.com', rows('@adobe.com')), false);
  });
  it('denies an address not present and not covered by a wildcard', () => {
    assert.equal(isVisitorAllowed('jane@other.com', rows('jane@example.com', '@adobe.com')), false);
  });
  it('denies a subdomain that does not exactly match the wildcard', () => {
    assert.equal(isVisitorAllowed('jane@corp.adobe.com', rows('@adobe.com')), false);
  });
  it('ignores empty and malformed rows', () => {
    assert.equal(isVisitorAllowed('jane@example.com', rows('', '   ', null, undefined)), false);
    assert.equal(isVisitorAllowed('jane@example.com', [{}, { email: 42 }]), false);
  });
  it('denies when the allowlist is empty (fail closed)', () => {
    assert.equal(isVisitorAllowed('jane@example.com', []), false);
  });
  it('denies on invalid inputs', () => {
    assert.equal(isVisitorAllowed('', rows('@adobe.com')), false);
    assert.equal(isVisitorAllowed('jane@example.com', null), false);
  });
});
