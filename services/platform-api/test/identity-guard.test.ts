import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionContext } from '@nestjs/common';
import { AuthenticatedActorGuard, AuthenticatedRequest } from '../src/identity-guard';
import { trustedGatewaySignature } from '../src/identity';
import { AppUser } from '../src/domain';
import { PlatformStore } from '../src/store';
import { UserDirectoryRepository } from '../src/user-directory';

function requestContext(headers: Record<string, string>): { request: AuthenticatedRequest; context: ExecutionContext } {
  const request: AuthenticatedRequest = { headers: { ...headers }, method: 'GET', url: '/api/v1/me' };
  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  };
}

test('one hundred registered employees only trigger identity writes for the twenty active sessions', async () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    mode: process.env.PLATFORM_IDENTITY_MODE,
    secret: process.env.TRUSTED_GATEWAY_HMAC_SECRET,
    interval: process.env.SSO_IDENTITY_SYNC_INTERVAL_SECONDS,
  };
  const secret = 'identity-guard-test-secret-at-least-32-characters';
  process.env.NODE_ENV = 'production';
  process.env.PLATFORM_IDENTITY_MODE = 'TRUSTED_GATEWAY';
  process.env.TRUSTED_GATEWAY_HMAC_SECRET = secret;
  process.env.SSO_IDENTITY_SYNC_INTERVAL_SECONDS = '300';

  const store = new PlatformStore({ dataFile: ':memory:', seed: false });
  let syncCalls = 0;
  const repository = {
    syncSsoIdentity: async (identity: { employeeNo: string; name: string; department?: string }) => {
      syncCalls += 1;
      const user: AppUser = {
        id: identity.employeeNo,
        employeeNo: identity.employeeNo,
        name: identity.name,
        orgUnitId: 'org-team',
        orgPath: '/org/team/',
        roles: ['learner'],
        status: 'ACTIVE',
        createdAt: new Date().toISOString(),
      };
      return { user, firstLogin: true, departmentMatched: true };
    },
  } as unknown as UserDirectoryRepository;

  try {
    const guard = new AuthenticatedActorGuard(repository, store);
    const headersFor = (index: number) => {
      const employeeNo = `employee-${String(index + 1).padStart(3, '0')}`;
      const name = `员工 ${index + 1}`;
      const department = 'AI 工程团队';
      const issuedAt = new Date().toISOString();
      return {
        'x-trusted-employee-no': employeeNo,
        'x-trusted-name': name,
        'x-trusted-department': department,
        'x-trusted-issued-at': issuedAt,
        'x-trusted-identity-signature': trustedGatewaySignature({ employeeNo, issuedAt, name, department }, secret),
      };
    };

    for (let index = 0; index < 100; index += 1) {
      const { context } = requestContext(headersFor(index));
      assert.equal(await guard.canActivate(context), true);
    }
    assert.equal(syncCalls, 100);

    await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const calls = Array.from({ length: 8 }, async () => {
        const { context, request } = requestContext(headersFor(index));
        assert.equal(await guard.canActivate(context), true);
        assert.equal(request.headers['x-employee-id'], `employee-${String(index + 1).padStart(3, '0')}`);
      });
      await Promise.all(calls);
    }));
    assert.equal(syncCalls, 100, 'recently synchronized identities must not create a write per API request');

    store.cacheUserSnapshot({ ...store.getUser('employee-001'), status: 'DISABLED' });
    const disabled = requestContext(headersFor(0));
    await assert.rejects(guard.canActivate(disabled.context), /账号已停用/);
    assert.equal(syncCalls, 100);
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.mode === undefined) delete process.env.PLATFORM_IDENTITY_MODE; else process.env.PLATFORM_IDENTITY_MODE = previous.mode;
    if (previous.secret === undefined) delete process.env.TRUSTED_GATEWAY_HMAC_SECRET; else process.env.TRUSTED_GATEWAY_HMAC_SECRET = previous.secret;
    if (previous.interval === undefined) delete process.env.SSO_IDENTITY_SYNC_INTERVAL_SECONDS; else process.env.SSO_IDENTITY_SYNC_INTERVAL_SECONDS = previous.interval;
  }
});
