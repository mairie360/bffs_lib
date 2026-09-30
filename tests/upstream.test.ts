import { HttpError, codeForStatus, defaultMessage, mapUpstreamError, upstreamStatus } from '../src';

describe('mapUpstreamError', () => {
  it('passes an HttpError through', () => {
    const error = new HttpError(401);
    expect(mapUpstreamError(error)).toBe(error);
  });

  it('keeps a declared 4xx status', () => {
    const mapped = mapUpstreamError({ status: 404, message: 'internal detail' }, [404]);
    expect(mapped.status).toBe(404);
    expect(mapped.message).not.toContain('internal');
  });

  it('reads the axios response status', () => {
    expect(mapUpstreamError({ response: { status: 401 } }, [401]).status).toBe(401);
  });

  it('maps undeclared 4xx to 502', () => {
    expect(mapUpstreamError({ status: 403 }, [404]).status).toBe(502);
    expect(mapUpstreamError({ status: 403 }).status).toBe(502);
  });

  it('maps upstream 5xx and non-HTTP failures to 502', () => {
    expect(mapUpstreamError({ status: 500 }, [500]).status).toBe(502);
    expect(mapUpstreamError(new Error('ECONNREFUSED')).status).toBe(502);
    expect(mapUpstreamError('weird').status).toBe(502);
  });
});

describe('upstreamStatus', () => {
  it('ignores non-error and non-numeric statuses', () => {
    expect(upstreamStatus({ status: 200 })).toBeUndefined();
    expect(upstreamStatus({ status: '404' })).toBeUndefined();
    expect(upstreamStatus(null)).toBeUndefined();
  });
});

describe('error codes', () => {
  it('derives the code from the status', () => {
    expect(codeForStatus(404)).toBe('NOT_FOUND');
    expect(codeForStatus(418)).toBe('BAD_REQUEST');
    expect(codeForStatus(599)).toBe('INTERNAL_ERROR');
    expect(defaultMessage('BAD_GATEWAY')).toBe('Upstream service error');
  });
});
