import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { PlatformStore } from './store';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: 75 * 1024 * 1024 }));
  const configuredOrigins = (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
  app.enableCors({ origin: configuredOrigins });
  const store = app.get(PlatformStore);
  app.getHttpAdapter().getInstance().addHook('onRequest', (request: any, reply: any, done: (error?: Error) => void) => {
    const supplied = request.headers['x-request-id'];
    const candidate = typeof supplied === 'string' ? supplied.trim() : '';
    const requestId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate) ? candidate : randomUUID();
    request.id = requestId;
    reply.header('x-request-id', requestId);

    // The internal SSO gateway may attach these trusted claims to every API
    // request. Provisioning here keeps the first request usable even when the
    // client has not made a separate login call yet. In production the gateway
    // must strip client-supplied x-sso-* headers before forwarding traffic.
    const employeeNo = String(request.headers['x-sso-employee-no'] ?? '').trim();
    if (employeeNo) {
      try {
        const synced = store.syncSsoIdentity({
          employeeNo,
          name: String(request.headers['x-sso-name'] ?? '').trim(),
          department: String(request.headers['x-sso-department'] ?? '').trim() || undefined,
        });
        request.headers['x-employee-id'] = synced.user.id;
      } catch (error) {
        done(error as Error);
        return;
      }
    }
    done();
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1');
}

void bootstrap();
