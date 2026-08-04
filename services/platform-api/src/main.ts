import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { createCorsOptions } from './cors-config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: 75 * 1024 * 1024 }));
  const fastify = app.getHttpAdapter().getInstance();
  // Upload handles support a real streaming/binary request in addition to
  // the JSON base64 compatibility path. Fastify does not parse octet-stream
  // by default; without this parser the route is rejected with 415 before
  // the controller can enforce the session size and checksum contract.
  fastify.addContentTypeParser(
    ['application/octet-stream', 'application/zip', 'application/x-zip-compressed'],
    { parseAs: 'buffer' },
    (_request: unknown, body: Buffer, done: (error: Error | null, value?: Buffer) => void) => done(null, body),
  );
  const configuredOrigins = (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
  app.enableCors(createCorsOptions(configuredOrigins));
  fastify.addHook('onRequest', (request: any, reply: any, done: (error?: Error) => void) => {
    const supplied = request.headers['x-request-id'];
    const candidate = typeof supplied === 'string' ? supplied.trim() : '';
    const requestId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate) ? candidate : randomUUID();
    request.id = requestId;
    reply.header('x-request-id', requestId);

    done();
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1');
}

void bootstrap();
