import type { Server } from 'node:http';

interface FetchTestApplication {
  listen(port: number, host: string): Promise<unknown>;
  getUrl(): Promise<string>;
  close(): Promise<unknown>;
}

// WHATWG Fetch rejects several historical service ports before opening a
// connection. Operating systems may still hand one of them to listen(0), so
// tests that combine an ephemeral server with fetch() need a safe range.
export function isFetchSafeTestUrl(baseUrl: string): boolean {
  const parsed = new URL(baseUrl);
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return Number.isInteger(port) && port >= 11_000 && port <= 65_535;
}

export async function createFetchSafeApplication<T extends FetchTestApplication>(factory: () => Promise<T>): Promise<{ app: T; baseUrl: string }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const app = await factory();
    try {
      await app.listen(0, '127.0.0.1');
      const baseUrl = await app.getUrl();
      if (isFetchSafeTestUrl(baseUrl)) return { app, baseUrl };
    } catch (error) {
      await app.close().catch(() => undefined);
      throw error;
    }
    await app.close();
  }
  throw new Error('无法分配 Fetch 可访问的本地测试端口');
}

export async function listenNodeServerOnFetchSafePort(server: Server): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
    const address = server.address();
    if (address && typeof address === 'object' && isFetchSafeTestUrl(`http://127.0.0.1:${address.port}`)) return address.port;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  throw new Error('无法分配 Fetch 可访问的本地测试端口');
}
