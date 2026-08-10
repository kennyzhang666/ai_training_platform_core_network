import type { Server } from 'node:http';

interface FetchTestApplication {
  listen(port: number, host: string): Promise<unknown>;
  getUrl(): Promise<string>;
  close(): Promise<unknown>;
}

const FETCH_SAFE_PORT_MIN = 11_000;
const FETCH_SAFE_PORT_MAX = 65_000;
const FETCH_SAFE_PORT_ATTEMPTS = 64;
let portSequence = process.pid % (FETCH_SAFE_PORT_MAX - FETCH_SAFE_PORT_MIN + 1);

function nextFetchSafePort(): number {
  const range = FETCH_SAFE_PORT_MAX - FETCH_SAFE_PORT_MIN + 1;
  portSequence = (portSequence + 7_919) % range;
  return FETCH_SAFE_PORT_MIN + portSequence;
}

function isRetryableBindError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

// WHATWG Fetch rejects several historical service ports before opening a
// connection. Request a port above that blocked range instead of trusting the
// operating system's listen(0) allocation, which can repeatedly return one.
export function isFetchSafeTestUrl(baseUrl: string): boolean {
  const parsed = new URL(baseUrl);
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return Number.isInteger(port) && port >= 11_000 && port <= 65_535;
}

export async function createFetchSafeApplication<T extends FetchTestApplication>(factory: () => Promise<T>): Promise<{ app: T; baseUrl: string }> {
  for (let attempt = 0; attempt < FETCH_SAFE_PORT_ATTEMPTS; attempt += 1) {
    const app = await factory();
    try {
      await app.listen(nextFetchSafePort(), '127.0.0.1');
      const baseUrl = await app.getUrl();
      if (isFetchSafeTestUrl(baseUrl)) return { app, baseUrl };
    } catch (error) {
      await app.close().catch(() => undefined);
      if (isRetryableBindError(error)) continue;
      throw error;
    }
    await app.close();
  }
  throw new Error('无法分配 Fetch 可访问的本地测试端口');
}

export async function listenNodeServerOnFetchSafePort(server: Server): Promise<number> {
  for (let attempt = 0; attempt < FETCH_SAFE_PORT_ATTEMPTS; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(nextFetchSafePort(), '127.0.0.1', () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      if (isRetryableBindError(error)) continue;
      throw error;
    }
    const address = server.address();
    if (address && typeof address === 'object' && isFetchSafeTestUrl(`http://127.0.0.1:${address.port}`)) return address.port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  throw new Error('无法分配 Fetch 可访问的本地测试端口');
}
