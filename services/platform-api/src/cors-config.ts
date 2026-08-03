const PLATFORM_BROWSER_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** Keep browser write operations aligned with the methods exposed by the API. */
export function createCorsOptions(origins: string[]) {
  return {
    origin: origins,
    methods: [...PLATFORM_BROWSER_METHODS],
    allowedHeaders: ['content-type', 'authorization', 'x-employee-id', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
  };
}
