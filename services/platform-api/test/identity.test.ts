import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { authenticateHeaders, loadIdentityConfig, resetIdentityKeyCache, trustedGatewaySignature, IdentityConfig } from '../src/identity';

test('production identity configuration cannot silently fall back to local headers', () => {
  assert.throws(() => loadIdentityConfig({ NODE_ENV: 'production' }), /must be explicitly configured/);
  assert.throws(() => loadIdentityConfig({ NODE_ENV: 'production', PLATFORM_IDENTITY_MODE: 'LOCAL' }), /not allowed in production/);
  assert.throws(() => loadIdentityConfig({ NODE_ENV: 'production', PLATFORM_IDENTITY_MODE: 'TRUSTED_GATEWAY' }), /TRUSTED_GATEWAY_HMAC_SECRET/);
  assert.throws(() => loadIdentityConfig({ NODE_ENV: 'production', PLATFORM_IDENTITY_MODE: 'OIDC', OIDC_ISSUER: 'http://issuer.test', OIDC_AUDIENCE: 'platform-api', OIDC_JWKS_URL: 'https://issuer.test/jwks' }), /OIDC_ISSUER must use HTTPS/);
  assert.throws(() => loadIdentityConfig({ NODE_ENV: 'production', PLATFORM_IDENTITY_MODE: 'OIDC', OIDC_ISSUER: 'not-a-url', OIDC_AUDIENCE: 'platform-api', OIDC_JWKS_URL: 'https://issuer.test/jwks' }), /OIDC_ISSUER must be a valid URL/);
  assert.throws(() => loadIdentityConfig({ NODE_ENV: 'production', PLATFORM_IDENTITY_MODE: 'OIDC', OIDC_ISSUER: 'https://issuer.test', OIDC_AUDIENCE: 'platform-api', OIDC_JWKS_URL: 'not-a-url' }), /OIDC_JWKS_URL must be a valid URL/);
});

test('local identity mode only accepts the configured development header', async () => {
  const config = loadIdentityConfig({ NODE_ENV: 'test', PLATFORM_IDENTITY_MODE: 'LOCAL', ALLOW_ANONYMOUS_LOCAL: 'false' });
  assert.deepEqual(await authenticateHeaders({ 'x-employee-id': 'worker-42' }, config), { employeeNo: 'worker-42', authenticationType: 'LOCAL' });
  await assert.rejects(authenticateHeaders({}, config), /authenticated identity is required/);
  const anonymous = loadIdentityConfig({ NODE_ENV: 'test', PLATFORM_IDENTITY_MODE: 'LOCAL', ALLOW_ANONYMOUS_LOCAL: 'true' });
  assert.equal((await authenticateHeaders({}, anonymous)).employeeNo, 'w00123');
});

test('trusted gateway identity requires a fresh HMAC-signed claim set', async () => {
  const secret = 'test-only-gateway-secret';
  const issuedAt = new Date().toISOString();
  const config = loadIdentityConfig({ NODE_ENV: 'production', PLATFORM_IDENTITY_MODE: 'TRUSTED_GATEWAY', TRUSTED_GATEWAY_HMAC_SECRET: secret });
  const headers = {
    'x-trusted-employee-no': 'worker-42',
    'x-trusted-issued-at': issuedAt,
    'x-trusted-name': 'Test Worker',
    'x-trusted-department': '/test/',
    'x-trusted-identity-signature': trustedGatewaySignature({ employeeNo: 'worker-42', issuedAt, name: 'Test Worker', department: '/test/' }, secret),
  };
  const actor = await authenticateHeaders(headers, config);
  assert.deepEqual(actor, { employeeNo: 'worker-42', authenticationType: 'TRUSTED_GATEWAY', issuedAt, name: 'Test Worker', department: '/test/' });
  await assert.rejects(authenticateHeaders({ ...headers, 'x-trusted-identity-signature': '00'.repeat(32) }, config), /signature is invalid/);
  await assert.rejects(authenticateHeaders({ ...headers, 'x-trusted-issued-at': '2020-01-01T00:00:00.000Z' }, config), /expired/);
});

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

test('OIDC mode verifies issuer, audience, expiry, key id and signature', async () => {
  resetIdentityKeyCache();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwk.kid = 'test-key';
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const config: IdentityConfig = {
    mode: 'OIDC', allowAnonymousLocal: false, oidcIssuer: 'https://issuer.test', oidcAudience: 'platform-api',
    oidcJwksUrl: `http://127.0.0.1:${address.port}/jwks`, oidcEmployeeClaim: 'employeeNo', oidcNameClaim: 'name', oidcDepartmentClaim: 'department',
    gatewayMaxAgeSeconds: 90, clockSkewSeconds: 30,
  };
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' }));
  const payload = base64Url(JSON.stringify({ iss: config.oidcIssuer, aud: config.oidcAudience, employeeNo: 'worker-42', name: 'OIDC Worker', department: '/test/', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const token = `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
  try {
    const actor = await authenticateHeaders({ authorization: `Bearer ${token}` }, config);
    assert.equal(actor.authenticationType, 'OIDC');
    assert.equal(actor.employeeNo, 'worker-42');
    assert.equal(actor.department, '/test/');
    await assert.rejects(authenticateHeaders({ authorization: 'Bearer invalid.token.value' }, config), /malformed/);
    await assert.rejects(authenticateHeaders({ authorization: `Bearer ${signingInput}.AA` }, config), /signature is invalid/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetIdentityKeyCache();
  }
});
