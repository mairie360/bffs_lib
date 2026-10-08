import { createTtlRedis, DEFAULT_MAX_TTL_SECONDS, fromIoredis, fromNodeRedis } from '../src';

function fakeRedis() {
  const calls: string[][] = [];
  const store = new Map<string, string>();
  const exec = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === 'SET') {
      if (args.includes('NX') && store.has(args[0])) return null;
      store.set(args[0], args[1]);
      return 'OK';
    }
    if (command === 'GET') return store.get(args[0]) ?? null;
    if (command === 'DEL') return store.delete(args[0]) ? 1 : 0;
    return 1;
  };
  return { calls, exec };
}

describe('createTtlRedis (MAIR-499)', () => {
  it('writes with SET … EX, prefixed, and reads back', async () => {
    const { calls, exec } = fakeRedis();
    const redis = createTtlRedis(exec, { keyPrefix: 'user-bff' });
    await expect(redis.setWithTtl('token', 'abc', 60)).resolves.toBe(true);
    await expect(redis.get('token')).resolves.toBe('abc');
    expect(calls[0]).toEqual(['SET', 'user-bff:token', 'abc', 'EX', '60']);
  });

  it('NX reports whether the key was written', async () => {
    const { calls, exec } = fakeRedis();
    const redis = createTtlRedis(exec);
    await expect(redis.setWithTtl('k', 'a', 10, { onlyIfAbsent: true })).resolves.toBe(true);
    await expect(redis.setWithTtl('k', 'b', 10, { onlyIfAbsent: true })).resolves.toBe(false);
    expect(calls[1]).toEqual(['SET', 'k', 'b', 'EX', '10', 'NX']);
  });

  it('refuses a missing, zero, fractional or too long TTL', async () => {
    const { exec } = fakeRedis();
    const redis = createTtlRedis(exec, { maxTtlSeconds: 3600 });
    for (const ttl of [0, -1, 1.5, 3601, Number.NaN]) {
      await expect(redis.setWithTtl('k', 'v', ttl)).rejects.toThrow(RangeError);
    }
    await expect(redis.expire('k', 0)).rejects.toThrow(RangeError);
    // @ts-expect-error: there is no write without a TTL
    expect(redis.set).toBeUndefined();
    expect(DEFAULT_MAX_TTL_SECONDS).toBe(86400);
  });

  it('deletes, renews and refuses an empty key', async () => {
    const { calls, exec } = fakeRedis();
    const redis = createTtlRedis(exec);
    await redis.delete('k');
    await redis.expire('k', 30);
    expect(calls).toEqual([['DEL', 'k'], ['EXPIRE', 'k', '30']]);
    await expect(redis.get('')).rejects.toThrow(TypeError);
    await expect(redis.get('missing')).resolves.toBeNull();
  });

  it('adapts ioredis and node-redis clients', async () => {
    const io = { call: jest.fn().mockResolvedValue('OK') };
    const node = { sendCommand: jest.fn().mockResolvedValue('OK') };
    await createTtlRedis(fromIoredis(io)).setWithTtl('a', 'b', 5);
    await createTtlRedis(fromNodeRedis(node)).setWithTtl('a', 'b', 5);
    expect(io.call).toHaveBeenCalledWith('SET', 'a', 'b', 'EX', '5');
    expect(node.sendCommand).toHaveBeenCalledWith(['SET', 'a', 'b', 'EX', '5']);
  });
});
