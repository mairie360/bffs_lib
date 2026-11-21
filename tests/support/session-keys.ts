import { createHmac, createPrivateKey, sign as edSign } from 'node:crypto';
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER, parseSessionPublicKeys } from '../../src';

// Session tokens signed like Core signs them (EdDSA). Same test key pair as mairie360_api_lib
// (`http_setup::TEST_JWT_*`), so tokens are interchangeable.
export const CORE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIB0n4h8LIrWP97xwhhjiuwTUvTF3l1E0MlDPQdPtlWcN
-----END PRIVATE KEY-----
`;
export const CORE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAKW8bV4kiFUo8hmOEU3+lXdqZL1wmKvBw6smUyjpmXks=
-----END PUBLIC KEY-----
`;
/** An attacker's key pair, or the next key of a rotation: never in `JWT_PUBLIC_KEY` unless stated. */
export const OTHER_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEII1DTYiu+dcwBgtEKil59uTH8s7XfrxGrbD+/P0sXq/8
-----END PRIVATE KEY-----
`;
export const OTHER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAtZHz1BNkijjkLJlnK9l7vikDl0aivrmbwllpT68Lnss=
-----END PUBLIC KEY-----
`;

export const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
export const kidOf = (publicPem: string) => [...parseSessionPublicKeys(publicPem).keys()][0];
export const CORE_KID = kidOf(CORE_PUBLIC_KEY);

/** Core's `iss` and `aud`, plus `extra`. */
export const sessionClaims = (extra: object = {}) => ({ iss: SESSION_JWT_ISSUER, aud: SESSION_JWT_AUDIENCE, ...extra });

/** Signs `payload` as is with `privatePem` (Core's key by default), header `EdDSA` + Core's `kid` by default. */
export function signEd(
  payload: unknown,
  { privatePem = CORE_PRIVATE_KEY, header = { alg: 'EdDSA', typ: 'JWT', kid: CORE_KID } as object } = {},
): string {
  const unsigned = `${part(header)}.${part(payload)}`;
  return `${unsigned}.${edSign(null, Buffer.from(unsigned), createPrivateKey(privatePem)).toString('base64url')}`;
}

/** An HS256 token signed with `secret`: what the BFFs accepted before the shared secret was removed. */
export function signHs(payload: unknown, secret: string | Buffer): string {
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}
