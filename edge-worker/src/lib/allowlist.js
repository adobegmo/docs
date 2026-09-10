/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

/*
 * Pure visitor-allowlist matcher, extracted from spectrum-hub website-lambda
 * handlers/auth.js. No platform bindings, so it is unit-testable in isolation.
 */

// An entry is either a full address (exact match) or a leading-'@' domain
// wildcard, e.g. "@adobe.com" allows anyone at adobe.com. All comparison is
// case-insensitive. An empty or malformed row never matches, so a config with
// no usable rows denies everyone - fail closed by construction.
export const isVisitorAllowed = (email, rows) => {
  if (typeof email !== 'string' || email === '' || !Array.isArray(rows)) { return false; }
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  const domain = at >= 0 ? normalized.slice(at) : '';
  return rows.some((row) => {
    const entry = typeof row?.email === 'string' ? row.email.trim().toLowerCase() : '';
    if (entry === '') { return false; }
    return entry.startsWith('@') ? entry === domain : entry === normalized;
  });
};
