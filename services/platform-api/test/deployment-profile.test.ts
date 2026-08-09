import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentProfile, isSingleNodeProduction } from '../src/deployment-profile';

test('deployment profile defaults to standard and accepts the single-node spelling', () => {
  assert.equal(deploymentProfile({}), 'standard');
  assert.equal(deploymentProfile({ PLATFORM_DEPLOYMENT_PROFILE: 'SINGLE_NODE' }), 'single-node');
  assert.equal(isSingleNodeProduction({ NODE_ENV: 'production', PLATFORM_DEPLOYMENT_PROFILE: 'single-node' }), true);
  assert.equal(isSingleNodeProduction({ NODE_ENV: 'test', PLATFORM_DEPLOYMENT_PROFILE: 'single-node' }), false);
});

test('deployment profile rejects unknown values', () => {
  assert.throws(() => deploymentProfile({ PLATFORM_DEPLOYMENT_PROFILE: 'desktop' }), /unsupported PLATFORM_DEPLOYMENT_PROFILE/);
});
