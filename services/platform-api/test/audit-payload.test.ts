import test from 'node:test';
import assert from 'node:assert/strict';
import { redactAuditPayload } from '../src/audit-payload';
import { PlatformStore } from '../src/store';

const avatar = `data:image/png;base64,${'A'.repeat(200_000)}`;

test('an audit payload keeps its shape but never carries an avatar data URL', () => {
  const redacted = redactAuditPayload({ id: 'w00123', name: '张三', status: 'ACTIVE', avatarDataUrl: avatar }) as Record<string, string>;
  assert.equal(redacted.id, 'w00123');
  assert.equal(redacted.name, '张三');
  assert.equal(redacted.status, 'ACTIVE');
  assert.doesNotMatch(redacted.avatarDataUrl, /AAAA/);
  assert.match(redacted.avatarDataUrl, /^\[audit:dropped \d+ bytes omitted\]$/);
});

test('an oversized string is truncated instead of stored whole', () => {
  const description = `<p>${'x'.repeat(4_000_000)}</p>`;
  const redacted = redactAuditPayload({ title: '赛题', description }) as Record<string, string>;
  assert.equal(redacted.title, '赛题');
  assert.ok(Buffer.byteLength(redacted.description, 'utf8') < 2_000, 'truncated description stays small');
  assert.match(redacted.description, /\[audit:truncated \d+ bytes omitted\]$/);
});

test('a redacted payload never exceeds the per-record ceiling', () => {
  const wide = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`field${index}`, 'y'.repeat(900)]));
  const redacted = redactAuditPayload(wide);
  assert.ok(Buffer.byteLength(JSON.stringify(redacted), 'utf8') <= 16 * 1024 + 128);
});

test('redaction does not mutate the caller object', () => {
  const source = { id: 'w00123', avatarDataUrl: avatar };
  redactAuditPayload(source);
  assert.equal(source.avatarDataUrl, avatar);
});

// The PostgreSQL unit of work skips its normalized re-synchronization when an
// operation turns out to be read-shaped. That decision reads `mutationCount`,
// so a read must never advance it and a write must always advance it.
test('mutationCount separates read-shaped operations from real writes', () => {
  const store = new PlatformStore({ dataFile: ':memory:', seed: true });
  const before = store.mutationCount;
  store.listChallenges('w00123');
  store.listEvents('w00123');
  store.systemEvaluationBatches();
  assert.equal(store.mutationCount, before, 'reads must not look like a write');

  store.createAnnouncement({ title: '通知', summary: '内容', tag: '平台通知', publishedAt: new Date().toISOString() }, 'w00123');
  assert.ok(store.mutationCount > before, 'a domain write must advance the counter');
});

// The repository writes audits from several call sites (org units, role
// changes, SSO sync). Redaction lives in `append` so none of them can leak a
// bulk field by forgetting to trim its own payload; this guards that choke
// point rather than any single caller.
test('repository audit rows are redacted at the single write entry point', async () => {
  const written: Array<Record<string, unknown>> = [];
  const { PrismaAuditRepository } = await import('../src/prisma-platform-repository');
  const db = { auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => (written.push(data), { ...data, createdAt: new Date(), before: data.before ?? null, after: data.after ?? null }) } };
  await new PrismaAuditRepository(db as never).append({
    id: 'audit-1', actorId: 'w00123', action: 'user.roles.update', target: 'user:w00124',
    before: { id: 'w00124', avatarDataUrl: avatar }, after: { id: 'w00124', avatarDataUrl: avatar },
    createdAt: new Date().toISOString(),
  });
  assert.equal(written.length, 1);
  assert.doesNotMatch(JSON.stringify(written[0]), /AAAAAAAA/, 'neither before nor after may carry the avatar');
});

test('a stored audit record does not retain the employee avatar', () => {
  const store = new PlatformStore({ dataFile: ':memory:', seed: true });
  // A profile is self-service, so the subject is also the actor.
  store.updateUserProfile('w00124', { nickname: '小李', avatarDataUrl: avatar }, 'w00124');
  const audits = store.listAudits(undefined, 'w00123').filter((record) => record.action === 'user.profile.update');
  assert.equal(audits.length, 1);
  const serialized = JSON.stringify(audits[0]);
  assert.doesNotMatch(serialized, /AAAAAAAA/, 'the base64 avatar must not reach the audit log');
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 8_000, `audit record stayed small (${Buffer.byteLength(serialized, 'utf8')} bytes)`);
});
