import test from 'node:test';
import assert from 'node:assert/strict';
import { redactLogText } from './log-redaction.mjs';

test('Worker log redaction removes headers, JSON secrets, tokens and URL credentials', () => {
  const raw = 'Authorization: Bearer bearer-secret password="plain-secret" token=token-secret https://user:pass@example.internal/simple ghp_1234567890abcdefghijkl';
  const redacted = redactLogText(raw);
  for (const secret of ['bearer-secret', 'plain-secret', 'token-secret', 'user:pass', 'ghp_1234567890abcdefghijkl']) {
    assert.equal(redacted.includes(secret), false);
  }
  assert.match(redacted, /\[REDACTED\]/);
});

test('Worker log redaction enforces its byte limit', () => {
  const redacted = redactLogText('测'.repeat(100), 25);
  assert.match(redacted, /\[TRUNCATED\]$/);
  assert.equal(redacted.includes('\uFFFD'), false);
  assert.ok(Buffer.byteLength(redacted.replace('…[TRUNCATED]', ''), 'utf8') <= 25);
});
