/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/*
 * Pure JWT decoding. No signature verification here: the caller (handlers/auth.js)
 * proves a token is genuine by handing it to IMS itself and checking IMS accepts
 * it, rather than checking a signature locally. Decoding is still useful once
 * that happens - the payload is where created_at/expires_in live. Ported from
 * spectrum-hub website-lambda lib/jwt.js.
 */

const base64urlToBase64 = (value) => {
  const padLength = (4 - (value.length % 4)) % 4;
  return value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLength);
};

const base64urlDecode = (value) => {
  const binary = atob(base64urlToBase64(value));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) { bytes[i] = binary.charCodeAt(i); }
  return bytes;
};

const decodeSegment = (segment) => JSON.parse(new TextDecoder().decode(base64urlDecode(segment)));

// Splits a JWT and parses its header/payload. Does not touch the signature
// segment - nothing here verifies it. A malformed segment (bad base64url,
// non-JSON, wrong segment count) is "not a JWT", not a throw.
export const decodeJwt = (token) => {
  if (typeof token !== 'string') { return null; }
  const parts = token.split('.');
  if (parts.length !== 3) { return null; }
  const [headerPart, payloadPart] = parts;
  try {
    return { header: decodeSegment(headerPart), payload: decodeSegment(payloadPart) };
  } catch {
    return null;
  }
};
