import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign, sign as signBuffer } from 'node:crypto';
import { authenticateHeaders, loadIdentityConfig, resetIdentityKeyCache, trustedGatewaySignature, IdentityConfig } from '../src/identity';
import { listenNodeServerOnFetchSafePort } from './test-server';

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

test('trusted gateway preserves already-decoded Unicode claim headers', async () => {
  const secret = 'test-only-gateway-secret';
  const issuedAt = new Date().toISOString();
  const name = '张三';
  const department = 'AI 工程团队';
  const config = loadIdentityConfig({ NODE_ENV: 'production', PLATFORM_IDENTITY_MODE: 'TRUSTED_GATEWAY', TRUSTED_GATEWAY_HMAC_SECRET: secret });
  const headers = {
    'x-trusted-employee-no': 'worker-cn',
    'x-trusted-issued-at': issuedAt,
    'x-trusted-name': name,
    'x-trusted-department': department,
    'x-trusted-identity-signature': trustedGatewaySignature({ employeeNo: 'worker-cn', issuedAt, name, department }, secret),
  };
  assert.deepEqual(await authenticateHeaders(headers, config), { employeeNo: 'worker-cn', authenticationType: 'TRUSTED_GATEWAY', issuedAt, name, department });
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
  const port = await listenNodeServerOnFetchSafePort(server);
  const config: IdentityConfig = {
    mode: 'OIDC', allowAnonymousLocal: false, oidcIssuer: 'https://issuer.test', oidcAudience: 'platform-api',
    oidcJwksUrl: `http://127.0.0.1:${port}/jwks`, oidcEmployeeClaim: 'employeeNo', oidcNameClaim: 'name', oidcDepartmentClaim: 'department',
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

/**
 * ES256 is advertised in the accepted algorithm list, so it must actually
 * verify. JOSE carries the signature as raw r||s and OpenSSL expects DER with
 * the shortest possible length encoding; a long-form length made every ES256
 * token fail closed with "signature is invalid".
 */
test('OIDC mode accepts an ES256 token signed by the published JWKS key', async () => {
  resetIdentityKeyCache();
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwk.kid = 'ec-key';
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  const port = await listenNodeServerOnFetchSafePort(server);
  const config: IdentityConfig = {
    mode: 'OIDC', allowAnonymousLocal: false, oidcIssuer: 'https://issuer.test', oidcAudience: 'platform-api',
    oidcJwksUrl: `http://127.0.0.1:${port}/jwks`, oidcEmployeeClaim: 'employeeNo', oidcNameClaim: 'name', oidcDepartmentClaim: 'department',
    gatewayMaxAgeSeconds: 90, clockSkewSeconds: 30,
  };
  const header = base64Url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'ec-key' }));
  const payload = base64Url(JSON.stringify({ iss: config.oidcIssuer, aud: config.oidcAudience, employeeNo: 'worker-77', name: 'EC Worker', department: '/test/', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 }));
  const signingInput = `${header}.${payload}`;
  const signature = signBuffer('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const token = `${signingInput}.${signature.toString('base64url')}`;
  try {
    const actor = await authenticateHeaders({ authorization: `Bearer ${token}` }, config);
    assert.equal(actor.authenticationType, 'OIDC');
    assert.equal(actor.employeeNo, 'worker-77');
    assert.equal(actor.department, '/test/');
    // A forged r||s of the correct length must still be rejected.
    const forged = `${signingInput}.${Buffer.alloc(64, 7).toString('base64url')}`;
    await assert.rejects(authenticateHeaders({ authorization: `Bearer ${forged}` }, config), /signature is invalid/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetIdentityKeyCache();
  }
});

/**
 * The JWKS response is cached for five minutes. Without a forced refresh on an
 * unknown key id, every request fails for the rest of that window as soon as
 * the issuer rotates its signing keys.
 */
test('an unknown key id refreshes the cached JWKS instead of failing until it expires', async () => {
  resetIdentityKeyCache();
  const first = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const firstJwk = { ...(first.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'key-1' };
  const rotatedJwk = { ...(rotated.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'key-2' };
  let rotatedYet = false;
  let fetches = 0;
  const server = createServer((request, response) => {
    fetches += 1;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys: rotatedYet ? [rotatedJwk] : [firstJwk] }));
  });
  const port = await listenNodeServerOnFetchSafePort(server);
  const config: IdentityConfig = {
    mode: 'OIDC', allowAnonymousLocal: false, oidcIssuer: 'https://issuer.test', oidcAudience: 'platform-api',
    oidcJwksUrl: `http://127.0.0.1:${port}/jwks`, oidcEmployeeClaim: 'employeeNo', oidcNameClaim: 'name', oidcDepartmentClaim: 'department',
    gatewayMaxAgeSeconds: 90, clockSkewSeconds: 30,
  };
  const tokenFor = (kid: string, key: import('node:crypto').KeyObject): string => {
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const payload = base64Url(JSON.stringify({ iss: config.oidcIssuer, aud: config.oidcAudience, employeeNo: 'worker-99', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 }));
    const signingInput = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    return `${signingInput}.${signer.sign(key).toString('base64url')}`;
  };
  try {
    assert.equal((await authenticateHeaders({ authorization: `Bearer ${tokenFor('key-1', first.privateKey)}` }, config)).employeeNo, 'worker-99');
    assert.equal(fetches, 1);
    rotatedYet = true;
    // The cache still holds key-1, so this only succeeds if the unknown kid
    // triggers exactly one forced refresh.
    assert.equal((await authenticateHeaders({ authorization: `Bearer ${tokenFor('key-2', rotated.privateKey)}` }, config)).employeeNo, 'worker-99');
    assert.equal(fetches, 2);
    await assert.rejects(authenticateHeaders({ authorization: `Bearer ${tokenFor('key-3', rotated.privateKey)}` }, config), /signing key is unknown/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    resetIdentityKeyCache();
  }
});
