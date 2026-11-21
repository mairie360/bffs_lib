import { createHmac, createPrivateKey, generateKeyPairSync, sign as edSign, type KeyPairKeyObjectResult } from 'node:crypto';
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER, parseSessionPublicKeys } from '../../src';

// Session tokens signed like Core signs them (EdDSA). The key pairs are generated when the tests load: no private
// key is committed.
const pem = (pair: KeyPairKeyObjectResult) => ({
  privatePem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
});
const core = pem(generateKeyPairSync('ed25519'));
/** An attacker's key pair, or the next key of a rotation: never in `JWT_PUBLIC_KEY` unless stated. */
const other = pem(generateKeyPairSync('ed25519'));

export const CORE_PRIVATE_KEY = core.privatePem;
export const CORE_PUBLIC_KEY = core.publicPem;
export const OTHER_PRIVATE_KEY = other.privatePem;
export const OTHER_PUBLIC_KEY = other.publicPem;

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
