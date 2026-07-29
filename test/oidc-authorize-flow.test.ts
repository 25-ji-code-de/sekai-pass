/*
 * Copyright 2026 The 25-ji-code-de Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const clientSource = readFileSync(
  join(import.meta.dirname, '../public/js/pages/authorize.js'),
  'utf8',
);
const apiSource = readFileSync(
  join(import.meta.dirname, '../src/lib/api.ts'),
  'utf8',
);

test('SPA authorization forwards OIDC scope and nonce', () => {
  assert.match(clientSource, /state,\s*scope,\s*nonce,\s*action:\s*'allow'/);
});

test('API authorization persists OIDC nonce before issuing the code', () => {
  assert.match(apiSource, /isOIDCRequest\(scope\)/);
  assert.match(
    apiSource,
    /INSERT INTO oidc_auth_data \(code, nonce, auth_time\) VALUES \(\?, \?, \?\)/,
  );
  assert.match(apiSource, /\.bind\(code, nonce, createdAt\)\.run\(\)/);
});
