import { assertConfigured, baseUrl } from '../src';

const ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ENV };
});

function configure(service: string, url?: string, port?: string) {
  delete process.env[`${service}_URL`];
  delete process.env[`${service}_PORT`];
  if (url !== undefined) process.env[`${service}_URL`] = url;
  if (port !== undefined) process.env[`${service}_PORT`] = port;
}

describe('baseUrl', () => {
  it.each([
    ['core-api', undefined, 'http://core-api'],
    ['core-api', '3000', 'http://core-api:3000'],
    ['http://core-api:3000/', '9999', 'http://core-api:3000'],
    ['HTTPS://core.example.org/api/', undefined, 'https://core.example.org/api'],
    ['  core-api  ', ' 3000 ', 'http://core-api:3000'],
  ])('builds %p + port %p -> %p', (url, port, expected) => {
    configure('CORE_API', url, port);
    expect(baseUrl('CORE_API')).toBe(expected);
  });

  it('reads the environment on every call', () => {
    configure('CORE_API', 'first');
    expect(baseUrl('CORE_API')).toBe('http://first');
    configure('CORE_API', 'second');
    expect(baseUrl('CORE_API')).toBe('http://second');
  });

  it.each([undefined, '', '   '])('answers 503 when the URL is %p, never localhost', (url) => {
    configure('CORE_API', url, '3000');
    expect(() => baseUrl('CORE_API')).toThrow(
      expect.objectContaining({ status: 503, message: 'The CORE_API service is not configured.' }),
    );
  });

  it.each([
    ['http://', undefined],
    ['core-api', 'abc'],
    ['core-api', '70000'],
  ])('answers 503 for the invalid configuration %p / %p', (url, port) => {
    configure('CORE_API', url, port);
    expect(() => baseUrl('CORE_API')).toThrow(
      expect.objectContaining({ status: 503, message: 'The CORE_API service is misconfigured.' }),
    );
  });
});

describe('assertConfigured', () => {
  it('passes when every service is configured', () => {
    configure('CORE_API', 'core-api');
    configure('USER_BFF', 'http://bff-user:4000');
    expect(() => assertConfigured(['CORE_API', 'USER_BFF'])).not.toThrow();
  });

  it('names every missing or invalid service', () => {
    configure('CORE_API', 'core-api');
    configure('USER_BFF');
    configure('PROJECT_API', 'http://');
    expect(() => assertConfigured(['CORE_API', 'USER_BFF', 'PROJECT_API'])).toThrow(
      'Missing or invalid upstream configuration: USER_BFF_URL, PROJECT_API_URL',
    );
  });
});
