import test from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';

// Keep the acceptance test isolated from a developer's persistent data and make
// the queue limit explicit so the test exercises back-pressure deterministically.
process.env.PLATFORM_DATA_FILE = ':memory:';
process.env.LOCAL_GRADING_CONCURRENCY = '2';
process.env.ALLOW_ANONYMOUS_LOCAL = 'true';
process.env.EMBEDDED_EVALUATION_WORKER = 'true';

async function withApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  await app.listen(0, '127.0.0.1');
  try {
    await run(await app.getUrl());
  } finally {
    await app.close();
  }
}

test('ten people can submit to an AUTO event and all runs drain through the bounded queue', async () => {
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

    const subjects = ['w00123', 'w00124', 'w00125', 'w00126', 'w00127', 'w00128', 'w00129', 'w00130', 'w00131', 'w00132'];
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

    const deadline = Date.now() + 15_000;
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
