/** Machine-readable error codes shared by every BFF. The HTTP status is the source of truth for the code. */
export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BAD_GATEWAY: 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT: 'GATEWAY_TIMEOUT',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: ERROR_CODES.BAD_REQUEST,
  401: ERROR_CODES.UNAUTHORIZED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  413: ERROR_CODES.PAYLOAD_TOO_LARGE,
  422: ERROR_CODES.UNPROCESSABLE_ENTITY,
  429: ERROR_CODES.TOO_MANY_REQUESTS,
  500: ERROR_CODES.INTERNAL_ERROR,
  502: ERROR_CODES.BAD_GATEWAY,
  503: ERROR_CODES.SERVICE_UNAVAILABLE,
  504: ERROR_CODES.GATEWAY_TIMEOUT,
};

const MESSAGE_BY_CODE: Record<ErrorCode, string> = {
  BAD_REQUEST: 'Invalid request',
  UNAUTHORIZED: 'Authentication required',
  FORBIDDEN: 'Access denied',
  NOT_FOUND: 'Resource not found',
  CONFLICT: 'Conflict with the current state of the resource',
  PAYLOAD_TOO_LARGE: 'Request body too large',
  UNPROCESSABLE_ENTITY: 'Unprocessable request',
  TOO_MANY_REQUESTS: 'Too many requests',
  INTERNAL_ERROR: 'Internal server error',
  BAD_GATEWAY: 'Upstream service error',
  SERVICE_UNAVAILABLE: 'Service unavailable',
  GATEWAY_TIMEOUT: 'Upstream service timed out',
};

/** Code for an HTTP status; unlisted 4xx fall back to BAD_REQUEST, everything else to INTERNAL_ERROR. */
export function codeForStatus(status: number): ErrorCode {
  return CODE_BY_STATUS[status] ?? (status >= 400 && status < 500 ? ERROR_CODES.BAD_REQUEST : ERROR_CODES.INTERNAL_ERROR);
}

/** Generic, non-leaking message for a code. */
export function defaultMessage(code: ErrorCode): string {
  return MESSAGE_BY_CODE[code];
}
