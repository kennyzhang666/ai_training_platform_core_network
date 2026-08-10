import test from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { createFetchSafeApplication } from './test-server';

// Keep the acceptance test isolated from a developer's persistent data and make
// the queue limit explicit so the test exercises back-pressure deterministically.
process.env.PLATFORM_DATA_FILE = ':memory:';
process.env.LOCAL_GRADING_CONCURRENCY = '2';
process.env.ALLOW_ANONYMOUS_LOCAL = 'true';
process.env.EMBEDDED_EVALUATION_WORKER = 'true';

async function withApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const { app, baseUrl } = await createFetchSafeApplication(
    () => NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter()),
  );
  try {
    await run(baseUrl);
  } finally {
    await app.close();
  }
}

test('one hundred people can submit to an AUTO event and all runs drain through the bounded queue', async () => {
  await withApp(async (baseUrl) => {
    const eventResponse = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'event-auto-concurrency',
        challengeVersion: 'parking-fee-01@1',
        submissionSource: 'UPLOAD',
        trigger: 'AUTO',
        reveal: 'IMMEDIATE',
        deliveryConfig: { allowedFormats: ['zip'], maxBytes: 50 * 1024 * 1024 },
        localGrading: {
          contractPath: 'challenges/parking-fee-v1/submission-contract.json',
          testsDir: 'challenges/parking-fee-v1/hidden-tests',
          entry: 'src/parking.py',
          function: 'calculate_fee',
          language: 'python',
        },
      }),
    });
    assert.equal(eventResponse.status, 201);

    const subjects = Array.from({ length: 100 }, (_, index) => `concurrent-learner-${String(index + 1).padStart(3, '0')}`);
    await Promise.all(subjects.map(async (employeeNo, index) => {
      const response = await fetch(`${baseUrl}/api/v1/auth/sso`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ employeeNo, name: `并发学员 ${index + 1}`, department: 'AI 工程团队' }),
      });
      assert.equal(response.status, 201);
    }));
    const submissions = await Promise.all(subjects.map(async (subjectId) => {
      const response = await fetch(`${baseUrl}/api/v1/events/event-auto-concurrency/submissions:upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subjectId,
          snapshot: {
            sourceType: 'UPLOAD',
            workspacePath: 'challenges/parking-fee-v1/starter',
            submittedAt: '2026-08-01T10:00:00Z',
          },
        }),
      });
      assert.equal(response.status, 201);
      return await response.json() as { id: string; state: string };
    }));
    assert.equal(new Set(submissions.map((submission) => submission.id)).size, subjects.length);
    assert.ok(submissions.every((submission) => submission.state === 'QUEUED'));

    const deadline = Date.now() + 60_000;
    let completed = 0;
    while (Date.now() < deadline) {
      const states = await Promise.all(submissions.map(async (submission) => {
        const response = await fetch(`${baseUrl}/api/v1/submissions/${submission.id}`);
        return await response.json() as { resultId?: string; state?: string };
      }));
      completed = states.filter((state) => Boolean(state.resultId)).length;
      if (completed === submissions.length) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(completed, subjects.length);

    const queueResponse = await fetch(`${baseUrl}/api/v1/admin/grading-queue`);
    assert.equal(queueResponse.status, 200);
    const queue = await queueResponse.json() as { queued: number; running: number; maxConcurrency: number; scheduled: number };
    assert.equal(queue.queued, 0);
    assert.equal(queue.running, 0);
    assert.equal(queue.scheduled, 0);
    assert.equal(queue.maxConcurrency, 2);
  });
});
