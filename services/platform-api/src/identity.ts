import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';

export type AuthenticationType = 'LOCAL' | 'OIDC' | 'TRUSTED_GATEWAY';
export type IdentityMode = AuthenticationType;

export interface AuthenticatedActor {
  employeeNo: string;
  authenticationType: AuthenticationType;
  issuedAt?: string;
  name?: string;
  department?: string;
}

export interface IdentityConfig {
  mode: IdentityMode;
  allowAnonymousLocal: boolean;
  gatewaySecret?: string;
  gatewayMaxAgeSeconds: number;
  oidcIssuer?: string;
  oidcAudience?: string;
  oidcJwksUrl?: string;
  oidcEmployeeClaim: string;
  oidcNameClaim: string;
  oidcDepartmentClaim: string;
  clockSkewSeconds: number;
}

export type HeaderMap = Record<string, string | string[] | undefined>;

function header(headers: HeaderMap, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? value[0]?.trim() : typeof value === 'string' ? value.trim() : undefined;
}

/** Decode UTF-8 claim bytes transported through WSGI's latin-1 header API. */
function trustedClaimHeader(value: string | undefined): string | undefined {
  if (!value) return value;
  // Node/Nginx normally expose the WSGI latin-1 transport as a string whose
  // code points are all <= 0xff. If a proxy has already decoded the header,
  // preserve the real Unicode value instead of truncating it through latin-1.
  if ([...value].some((character) => (character.codePointAt(0) ?? 0) > 0xff)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? value : decoded;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the selected identity mode`);
  return value;
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 86_400) throw new Error(`${name} must be a positive number no greater than 86400`);
  return value;
}

/** Load and validate identity configuration once at application startup. */
export function loadIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const production = env.NODE_ENV === 'production';
  const configuredMode = env.PLATFORM_IDENTITY_MODE?.trim().toUpperCase();
  if (production && !configuredMode) throw new Error('PLATFORM_IDENTITY_MODE must be explicitly configured in production');
  const mode = (configuredMode || 'LOCAL') as IdentityMode;
  if (!['LOCAL', 'OIDC', 'TRUSTED_GATEWAY'].includes(mode)) throw new Error(`unsupported PLATFORM_IDENTITY_MODE: ${mode}`);
  if (production && mode === 'LOCAL') throw new Error('LOCAL identity mode is not allowed in production');

  const config: IdentityConfig = {
    mode,
    allowAnonymousLocal: !production && env.ALLOW_ANONYMOUS_LOCAL === 'true',
    gatewayMaxAgeSeconds: positiveNumber(env, 'TRUSTED_GATEWAY_MAX_AGE_SECONDS', 90),
    oidcEmployeeClaim: env.OIDC_EMPLOYEE_CLAIM?.trim() || 'employeeNo',
    oidcNameClaim: env.OIDC_NAME_CLAIM?.trim() || 'name',
    oidcDepartmentClaim: env.OIDC_DEPARTMENT_CLAIM?.trim() || 'department',
    clockSkewSeconds: positiveNumber(env, 'OIDC_CLOCK_SKEW_SECONDS', 30),
  };
  if (mode === 'TRUSTED_GATEWAY') config.gatewaySecret = required(env, 'TRUSTED_GATEWAY_HMAC_SECRET');
  if (mode === 'OIDC') {
    config.oidcIssuer = required(env, 'OIDC_ISSUER');
    config.oidcAudience = required(env, 'OIDC_AUDIENCE');
    config.oidcJwksUrl = required(env, 'OIDC_JWKS_URL');
    let issuerUrl: URL;
    try {
      issuerUrl = new URL(config.oidcIssuer);
    } catch {
      throw new Error('OIDC_ISSUER must be a valid URL');
    }
    if (production && issuerUrl.protocol !== 'https:') throw new Error('OIDC_ISSUER must use HTTPS in production');
    let jwksUrl: URL;
    try {
      jwksUrl = new URL(config.oidcJwksUrl);
    } catch {
      throw new Error('OIDC_JWKS_URL must be a valid URL');
    }
    if (production && jwksUrl.protocol !== 'https:') throw new Error('OIDC_JWKS_URL must use HTTPS in production');
  }
  return config;
}

function unauthorized(message: string): never {
  throw new UnauthorizedException(message);
}

function base64UrlDecode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) unauthorized('identity token is malformed');
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4), 'base64');
}

function parseJsonSegment(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(base64UrlDecode(value).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) unauthorized('identity token is malformed');
    return parsed as Record<string, unknown>;
  } catch {
    unauthorized('identity token is malformed');
  }
}

interface JsonWebKeySet { keys: Array<Record<string, unknown>> }

let jwksCache: { url: string; expiresAt: number; value: JsonWebKeySet } | undefined;

async function loadJwks(url: string, forceRefresh = false): Promise<JsonWebKeySet> {
  const cached = jwksCache;
  if (!forceRefresh && cached && cached.url === url && cached.expiresAt > Date.now()) return cached.value;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) unauthorized('OIDC signing keys are unavailable');
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { keys?: unknown }).keys)) unauthorized('OIDC signing keys are invalid');
    const value = payload as JsonWebKeySet;
    jwksCache = { url, expiresAt: Date.now() + 5 * 60_000, value };
    return value;
  } catch (error) {
    if (error instanceof UnauthorizedException) throw error;
    unauthorized('OIDC signing keys are unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

function ecdsaJoseToDer(signature: Buffer): Buffer {
  if (signature.length % 2 !== 0 || signature.length < 64) unauthorized('OIDC token signature is malformed');
  const half = signature.length / 2;
  const integer = (part: Buffer): Buffer => {
    let value = part;
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };
  const body = Buffer.concat([integer(signature.subarray(0, half)), integer(signature.subarray(half))]);
  // DER requires the shortest possible length encoding. OpenSSL rejects the
  // long form for lengths below 128, so an ES256 signature (body <= 72 bytes)
  // must use the single-byte short form or verification always fails.
  if (body.length < 128) return Buffer.concat([Buffer.from([0x30, body.length]), body]);
  if (body.length < 256) return Buffer.concat([Buffer.from([0x30, 0x81, body.length]), body]);
  return Buffer.concat([Buffer.from([0x30, 0x82, body.length >> 8, body.length & 0xff]), body]);
}

async function verifyOidcToken(token: string, config: IdentityConfig): Promise<AuthenticatedActor> {
  const parts = token.split('.');
  if (parts.length !== 3) unauthorized('identity token is malformed');
  const headerPart = parseJsonSegment(parts[0]);
  const claims = parseJsonSegment(parts[1]);
  const algorithm = headerPart.alg;
  const kid = headerPart.kid;
  if (typeof algorithm !== 'string' || typeof kid !== 'string') unauthorized('identity token header is incomplete');
  if (!['RS256', 'RS384', 'RS512', 'ES256'].includes(algorithm)) unauthorized('identity token algorithm is not allowed');
  let jwks = await loadJwks(config.oidcJwksUrl!);
  let jwk = jwks.keys.find((key) => key.kid === kid);
  if (!jwk) {
    // The issuer may have rotated signing keys since the last fetch. Refresh
    // once before rejecting, otherwise every request fails for the remaining
    // cache lifetime after a rotation.
    jwks = await loadJwks(config.oidcJwksUrl!, true);
    jwk = jwks.keys.find((key) => key.kid === kid);
  }
  if (!jwk) unauthorized('identity token signing key is unknown');
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    unauthorized('identity token signing key is invalid');
  }
  const signature = base64UrlDecode(parts[2]);
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  let verified = false;
  try {
    verified = verifySignature(
      algorithm.startsWith('RS') ? `RSA-SHA${algorithm.slice(2)}` : 'sha256',
      signingInput,
      publicKey!,
      algorithm === 'ES256' ? ecdsaJoseToDer(signature) : signature,
    );
  } catch {
    // OpenSSL throws for malformed signature lengths/encodings.  Treat those
    // inputs as an authentication failure rather than leaking a 500 response.
    unauthorized('identity token signature is invalid');
  }
  if (!verified) unauthorized('identity token signature is invalid');
  const now = Math.floor(Date.now() / 1000);
  const exp = typeof claims.exp === 'number' ? claims.exp : undefined;
  const nbf = typeof claims.nbf === 'number' ? claims.nbf : undefined;
  if (exp === undefined || exp < now - config.clockSkewSeconds) unauthorized('identity token is expired');
  if (nbf !== undefined && nbf > now + config.clockSkewSeconds) unauthorized('identity token is not yet valid');
  if (claims.iss !== config.oidcIssuer) unauthorized('identity token issuer is invalid');
  const audience = claims.aud;
  if (!(audience === config.oidcAudience || (Array.isArray(audience) && audience.includes(config.oidcAudience)))) unauthorized('identity token audience is invalid');
  const employeeNo = claims[config.oidcEmployeeClaim];
  if (typeof employeeNo !== 'string' || !employeeNo.trim()) unauthorized('identity token has no employee claim');
  const name = claims[config.oidcNameClaim];
  const department = claims[config.oidcDepartmentClaim];
  return {
    employeeNo: employeeNo.trim(),
    authenticationType: 'OIDC',
    ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
    ...(typeof department === 'string' && department.trim() ? { department: department.trim() } : {}),
    ...(typeof claims.iat === 'number' ? { issuedAt: new Date(claims.iat * 1000).toISOString() } : {}),
  };
}

export function trustedGatewaySignature(input: { employeeNo: string; issuedAt: string; name?: string; department?: string }, secret: string): string {
  const payload = `${input.employeeNo}\n${input.issuedAt}\n${input.name ?? ''}\n${input.department ?? ''}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

async function verifyTrustedGateway(headers: HeaderMap, config: IdentityConfig): Promise<AuthenticatedActor> {
  const employeeNo = header(headers, 'x-trusted-employee-no');
  const issuedAt = header(headers, 'x-trusted-issued-at');
  const signature = header(headers, 'x-trusted-identity-signature');
  if (!employeeNo || !issuedAt || !signature) unauthorized('trusted gateway identity is missing');
  const issuedMillis = Date.parse(issuedAt);
  if (!Number.isFinite(issuedMillis) || Math.abs(Date.now() - issuedMillis) > config.gatewayMaxAgeSeconds * 1000) unauthorized('trusted gateway identity is expired');
  const name = trustedClaimHeader(header(headers, 'x-trusted-name'));
  const department = trustedClaimHeader(header(headers, 'x-trusted-department'));
  const expected = trustedGatewaySignature({ employeeNo, issuedAt, name, department }, config.gatewaySecret!);
  const received = Buffer.from(signature, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  if (received.length !== expectedBytes.length || !timingSafeEqual(received, expectedBytes)) unauthorized('trusted gateway identity signature is invalid');
  return { employeeNo, authenticationType: 'TRUSTED_GATEWAY', issuedAt, ...(name ? { name } : {}), ...(department ? { department } : {}) };
}

/** Resolve a request identity; plain employee headers are accepted only in LOCAL mode. */
export async function authenticateHeaders(headers: HeaderMap, config: IdentityConfig): Promise<AuthenticatedActor> {
  if (config.mode === 'LOCAL') {
    const employeeNo = header(headers, 'x-employee-id');
    if (employeeNo) return { employeeNo, authenticationType: 'LOCAL' };
    if (config.allowAnonymousLocal) return { employeeNo: 'w00123', authenticationType: 'LOCAL' };
    unauthorized('authenticated identity is required');
  }
  if (config.mode === 'TRUSTED_GATEWAY') return verifyTrustedGateway(headers, config);
  const authorization = header(headers, 'authorization');
  if (!authorization?.startsWith('Bearer ')) unauthorized('Bearer identity token is required');
  return verifyOidcToken(authorization.slice('Bearer '.length).trim(), config);
}

export function resetIdentityKeyCache(): void {
  jwksCache = undefined;
}
