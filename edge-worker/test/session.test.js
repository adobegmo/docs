/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import assert from 'node:assert/strict';
import {
  deriveExpiry, clampExpiry, DEFAULT_MAX_AGE_MS, signToken, serializeCookie,
  createSessionCookies, durationMs, DEFAULT_SESSION_COOKIE_NAME,
  DEFAULT_SESSION_HINT_COOKIE_NAME, verifySignedToken, readSession,
} from '../src/lib/session.js';

const NOW = 1785812270230;
const imsBody = (overrides = {}) => ({
  token: 'header.payload.signature',
  expires_in: '86400000',
  created_at: '1785812270230',
  ...overrides,
});

describe('deriveExpiry', () => {
  it('adds string expires_in to string created_at', () => {
    assert.equal(deriveExpiry(imsBody()), 1785898670230);
  });
  it('accepts numeric values', () => {
    assert.equal(deriveExpiry({ created_at: NOW, expires_in: 1000 }), NOW + 1000);
  });
  it('returns null when created_at is missing', () => {
    assert.equal(deriveExpiry(imsBody({ created_at: undefined })), null);
  });
  it('returns null for an empty string rather than coercing it to zero', () => {
    assert.equal(deriveExpiry(imsBody({ expires_in: '  ' })), null);
  });
  it('returns null when the body is not an object', () => {
    assert.equal(deriveExpiry(null), null);
  });
});

describe('clampExpiry', () => {
  it('caps an over-ceiling expiry at now + maxAgeMs', () => {
    const capped = clampExpiry(NOW + 999999999999, NOW, DEFAULT_MAX_AGE_MS);
    assert.equal(capped, NOW + DEFAULT_MAX_AGE_MS);
  });
  it('leaves an expiry inside the ceiling untouched', () => {
    assert.equal(clampExpiry(NOW + 1000, NOW, DEFAULT_MAX_AGE_MS), NOW + 1000);
  });
});

describe('durationMs', () => {
  it('falls back on non-numeric / non-positive input', () => {
    assert.equal(durationMs('nope', 42), 42);
    assert.equal(durationMs('  ', 42), 42);
    assert.equal(durationMs('-1', 42), 42);
    assert.equal(durationMs('100', 42), 100);
  });
});

describe('signToken', () => {
  const TOKEN = 'header.payload.signature';
  const SECRET = 'test-secret';

  it('returns exactly two dot-separated segments', async () => {
    assert.equal((await signToken(TOKEN, SECRET)).split('.').length, 2);
  });
  it('emits no base64 padding or url-unsafe characters', async () => {
    assert.match(await signToken(TOKEN, SECRET), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
  it('is deterministic for the same token and secret', async () => {
    assert.equal(await signToken(TOKEN, SECRET), await signToken(TOKEN, SECRET));
  });
  it('produces a different signature under a different secret', async () => {
    const a = (await signToken(TOKEN, SECRET)).split('.')[1];
    const b = (await signToken(TOKEN, 'other-secret')).split('.')[1];
    assert.notEqual(a, b);
  });
  // Golden vector: pins the wire format of every issued cookie. The signature
  // is HMAC-SHA256 over the base64url PAYLOAD, not the raw token.
  it('matches the golden vector for a fixed token and secret', async () => {
    assert.equal(
      await signToken('header.payload.signature', 'golden-secret'),
      'aGVhZGVyLnBheWxvYWQuc2lnbmF0dXJl.RNLO47QouZdia7P5fDyLKPtwmfknB5CipfpjjUvzQ9g',
    );
  });
});

describe('verifySignedToken', () => {
  const SECRET = 'test-secret';
  it('round-trips a signed value', async () => {
    const signed = await signToken('the-claims', SECRET);
    assert.equal(await verifySignedToken(signed, SECRET), 'the-claims');
  });
  it('rejects a tampered payload', async () => {
    const signed = await signToken('the-claims', SECRET);
    const tampered = `${signed.slice(0, 3)}X${signed.slice(4)}`;
    assert.equal(await verifySignedToken(tampered, SECRET), null);
  });
  it('rejects a value signed with a different secret', async () => {
    const signed = await signToken('the-claims', 'other');
    assert.equal(await verifySignedToken(signed, SECRET), null);
  });
  it('rejects values without exactly one dot', async () => {
    assert.equal(await verifySignedToken('nodot', SECRET), null);
    assert.equal(await verifySignedToken('a.b.c', SECRET), null);
  });
  it('rejects an empty secret', async () => {
    assert.equal(await verifySignedToken('a.b', ''), null);
  });
});

describe('readSession', () => {
  const SECRET = 'test-secret';
  const mint = async (claims) => signToken(JSON.stringify(claims), SECRET);

  it('returns the claims for a live, valid cookie', async () => {
    const claims = { email: 'a@adobe.com', created_at: NOW, expires_in: 1000 };
    const cookie = await mint(claims);
    const out = await readSession(cookie, SECRET, NOW + 500);
    assert.equal(out.email, 'a@adobe.com');
  });
  it('returns null once the token has expired', async () => {
    const cookie = await mint({ email: 'a@adobe.com', created_at: NOW, expires_in: 1000 });
    assert.equal(await readSession(cookie, SECRET, NOW + 2000), null);
  });
  it('returns null for a forged cookie', async () => {
    const cookie = await mint({ email: 'a@adobe.com', created_at: NOW, expires_in: 1000 });
    assert.equal(await readSession(cookie, 'wrong-secret', NOW + 500), null);
  });
});

describe('serializeCookie', () => {
  it('emits Secure + HttpOnly when requested', () => {
    const c = serializeCookie('n', 'v', { maxAgeSeconds: 60, httpOnly: true, secure: true });
    assert.match(c, /^n=v; Path=\/; SameSite=Lax; Max-Age=60; Secure; HttpOnly$/);
  });
  it('omits HttpOnly for the readable companion', () => {
    const c = serializeCookie('n', 'v', { maxAgeSeconds: 60, httpOnly: false, secure: true });
    assert.ok(!c.includes('HttpOnly'));
  });
});

describe('createSessionCookies', () => {
  const config = { secret: 'test-secret', secure: true };

  it('mints both the session and the readable hint cookie', async () => {
    const result = await createSessionCookies({
      body: { token: 'claims', created_at: NOW, expires_in: 1000 },
      now: NOW,
      config,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.cookies.length, 2);
    assert.ok(result.cookies[0].startsWith(`${DEFAULT_SESSION_COOKIE_NAME}=`));
    assert.ok(result.cookies[0].includes('HttpOnly'));
    assert.ok(result.cookies[1].startsWith(`${DEFAULT_SESSION_HINT_COOKIE_NAME}=`));
    assert.ok(!result.cookies[1].includes('HttpOnly'));
    assert.equal(result.expiresAt, NOW + 1000);
  });
  it('fails without a secret', async () => {
    const result = await createSessionCookies({
      body: { token: 'claims', created_at: NOW, expires_in: 1000 },
      now: NOW,
      config: { secret: '', secure: true },
    });
    assert.equal(result.error.status, 500);
  });
  it('refuses an already-expired session', async () => {
    const result = await createSessionCookies({
      body: { token: 'claims', created_at: NOW, expires_in: 0 },
      now: NOW,
      config,
    });
    assert.equal(result.error.status, 400);
  });
});
