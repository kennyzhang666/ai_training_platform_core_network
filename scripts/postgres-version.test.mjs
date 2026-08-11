import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPostgres14Compatible,
  postgresMajorFromVersionNum,
} from '../services/platform-api/scripts/check-postgres-version.mjs';

test('PostgreSQL server_version_num is interpreted by major version', () => {
  assert.equal(postgresMajorFromVersionNum('140011'), 14);
  assert.equal(postgresMajorFromVersionNum(170004), 17);
  assert.throws(() => postgresMajorFromVersionNum('14.11'), /server_version_num/);
});

test('the production database compatibility baseline accepts PostgreSQL 14 and newer', () => {
  assert.equal(assertPostgres14Compatible('140000', '14.0'), 14);
  assert.equal(assertPostgres14Compatible('140011', '14.11'), 14);
  assert.equal(assertPostgres14Compatible('170004', '17.4'), 17);
});

test('the production database compatibility baseline rejects PostgreSQL 13 and older', () => {
  assert.throws(
    () => assertPostgres14Compatible('130019', '13.19'),
    /PostgreSQL 14 及以上版本/,
  );
});
