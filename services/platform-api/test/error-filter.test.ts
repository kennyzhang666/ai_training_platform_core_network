import test from 'node:test';
import assert from 'node:assert/strict';
import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { ApiExceptionFilter } from '../src/error-filter';

function capture(exception: unknown): { status: number; payload: Record<string, unknown> } {
  let status = 0;
  let payload: Record<string, unknown> = {};
  const response = {
    sent: false,
    header: () => response,
    status: (value: number) => {
      status = value;
      return response;
    },
    send: (value: Record<string, unknown>) => {
      payload = value;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ id: 'request-test' }),
    }),
  } as unknown as ArgumentsHost;
  new ApiExceptionFilter().catch(exception, host);
  return { status, payload };
}

test('unexpected server errors do not expose internal exception messages', () => {
  const result = capture(new Error('database path C:\\internal\\platform-data.json'));
  assert.equal(result.status, 500);
  assert.equal(result.payload.code, 'INTERNAL_ERROR');
  assert.equal(result.payload.message, 'Internal server error');
  assert.doesNotMatch(JSON.stringify(result.payload), /platform-data/);
});

test('expected HTTP errors preserve their stable client message', () => {
  const result = capture(new BadRequestException({ code: 'INVALID_INPUT', message: '请求参数无效' }));
  assert.equal(result.status, 400);
  assert.equal(result.payload.code, 'INVALID_INPUT');
  assert.equal(result.payload.message, '请求参数无效');
});
