import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITY_DOMAINS, CAPABILITY_ITEMS, CAPABILITY_ITEM_BY_KEY } from '../src/capability-catalog';

test('v1.1 capability catalog keeps eight domains and sixteen traceable rubric points', () => {
  assert.equal(CAPABILITY_DOMAINS.length, 8);
  assert.equal(CAPABILITY_ITEMS.length, 16);
  for (const domain of CAPABILITY_DOMAINS) {
    assert.ok(domain.criterionKeys.length > 0, `${domain.key} must map to rubric evidence`);
    for (const criterionKey of domain.criterionKeys) {
      const item = CAPABILITY_ITEM_BY_KEY.get(criterionKey);
      assert.ok(item, `missing rubric item for ${criterionKey}`);
      assert.ok(item.domainKeys.includes(domain.key), `${criterionKey} is not reverse-mapped to ${domain.key}`);
    }
  }
  for (const item of CAPABILITY_ITEMS) {
    assert.ok(item.domainKeys.length > 0, `${item.dimension}:${item.key} must map to a capability domain`);
    for (const domainKey of item.domainKeys) {
      assert.ok(CAPABILITY_DOMAINS.some((domain) => domain.key === domainKey), `unknown capability domain ${domainKey}`);
    }
  }
});
