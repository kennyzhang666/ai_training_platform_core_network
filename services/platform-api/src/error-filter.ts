import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';

type ErrorBody = {
  code?: string;
  message?: string | string[];
  [key: string]: unknown;
};

/** Keep client-visible errors machine-readable while retaining a short human message. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<any>();
    const request = http.getRequest<any>();
    if (response?.sent) return;

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = isHttpException ? exception.getResponse() : undefined;
    const body: ErrorBody = raw && typeof raw === 'object' ? { ...(raw as ErrorBody) } : {};
    const message = !isHttpException
      ? 'Internal server error'
      : Array.isArray(body.message)
        ? body.message.join('; ')
        : typeof body.message === 'string'
          ? body.message
          : typeof raw === 'string'
            ? raw
            : 'request failed';
    const code = typeof body.code === 'string' ? body.code : status >= 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`;
    const requestId = typeof request?.id === 'string' ? request.id : undefined;
    if (!isHttpException || status >= 500) {
      const details = exception instanceof Error ? exception.stack ?? exception.message : String(exception);
      this.logger.error(`request ${requestId ?? '-'} failed`, details);
    }
    const details = Object.fromEntries(Object.entries(body).filter(([key]) => !['code', 'message', 'statusCode', 'error'].includes(key)));
    const payload = { code, message, ...(requestId ? { requestId } : {}), ...(Object.keys(details).length ? { details } : {}) };
    if (requestId && typeof response?.header === 'function') response.header('x-request-id', requestId);
    if (typeof response?.status === 'function') response.status(status).send(payload);
  }
}
