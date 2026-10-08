/**
 * Redis client of the BFFs (MAIR-499): every write carries a time to live.
 *
 * No BFF uses Redis yet; when one does, it goes through this client so that a key never outlives
 * its purpose (sessions, one-time tokens, cached answers hold personal data). There is no plain
 * `set`: `setWithTtl` is the only write, with a whole number of seconds between 1 and `maxTtl`.
 *
 * The lib has no Redis dependency. The client runs on a command executor that the BFF builds from
 * its own driver: `fromIoredis(client)` (ioredis `call`) or `fromNodeRedis(client)` (node-redis
 * `sendCommand`). Only `GET`, `SET … EX [NX]`, `DEL` and `EXPIRE` are sent, the commands the
 * platform's Redis ACL grants (no `SETEX`).
 */

/** Runs one Redis command and resolves with its raw reply. */
export type RedisCommandExecutor = (command: string, args: string[]) => Promise<unknown>;

export interface TtlRedisOptions {
  /** Key prefix of the BFF's ACL role (`<role>:`); added to every key. */
  keyPrefix?: string;
  /** Longest TTL accepted, in seconds (default one day). */
  maxTtlSeconds?: number;
}

export interface SetWithTtlOptions {
  /** Only write when the key does not exist (`NX`). */
  onlyIfAbsent?: boolean;
}

export const DEFAULT_MAX_TTL_SECONDS = 24 * 60 * 60;

export interface TtlRedis {
  /** `SET key value EX ttl [NX]`; resolves with whether the key was written. */
  setWithTtl(key: string, value: string, ttlSeconds: number, options?: SetWithTtlOptions): Promise<boolean>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
  /** Shortens or renews the TTL of an existing key (no-op on a missing key). */
  expire(key: string, ttlSeconds: number): Promise<void>;
}

function checkTtl(ttlSeconds: number, max: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > max) {
    throw new RangeError(`a Redis TTL must be a whole number of seconds between 1 and ${max}`);
  }
}

/** The Redis client of a BFF, on `exec` (see `fromIoredis` / `fromNodeRedis`). */
export function createTtlRedis(exec: RedisCommandExecutor, options: TtlRedisOptions = {}): TtlRedis {
  const max = options.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS;
  checkTtl(max, Number.MAX_SAFE_INTEGER);
  const prefix = options.keyPrefix ? `${options.keyPrefix}:` : '';
  const full = (key: string): string => {
    if (!key) throw new TypeError('a Redis key must not be empty');
    return `${prefix}${key}`;
  };
  return {
    async setWithTtl(key, value, ttlSeconds, { onlyIfAbsent = false } = {}) {
      checkTtl(ttlSeconds, max);
      const args = [full(key), value, 'EX', String(ttlSeconds)];
      if (onlyIfAbsent) args.push('NX');
      // `OK` when written, null when NX found the key.
      return (await exec('SET', args)) !== null;
    },
    async get(key) {
      const reply = await exec('GET', [full(key)]);
      return reply === null || reply === undefined ? null : String(reply);
    },
    async delete(key) {
      await exec('DEL', [full(key)]);
    },
    async expire(key, ttlSeconds) {
      checkTtl(ttlSeconds, max);
      await exec('EXPIRE', [full(key), String(ttlSeconds)]);
    },
  };
}

/** Executor on an ioredis client (`client.call(command, ...args)`). */
export function fromIoredis(client: { call: (command: string, ...args: string[]) => Promise<unknown> }): RedisCommandExecutor {
  return (command, args) => client.call(command, ...args);
}

/** Executor on a node-redis v4+ client (`client.sendCommand([command, ...args])`). */
export function fromNodeRedis(client: { sendCommand: (args: string[]) => Promise<unknown> }): RedisCommandExecutor {
  return (command, args) => client.sendCommand([command, ...args]);
}
