import { MemoryCache, callerKey } from '../src';

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('MemoryCache (MAIR-525)', () => {
  it('serves a value until its TTL ends', () => {
    const time = clock();
    const cache = new MemoryCache<string>({ ttlMs: 100, now: time.now });
    cache.set('a', 'A');
    time.advance(99);
    expect(cache.get('a')).toBe('A');
    time.advance(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('loads once for concurrent reads of the same key', async () => {
    const cache = new MemoryCache<number>({ ttlMs: 1_000 });
    const load = jest.fn(async () => 42);
    const values = await Promise.all([cache.getOrLoad('k', load), cache.getOrLoad('k', load), cache.getOrLoad('k', load)]);
    expect(values).toEqual([42, 42, 42]);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(cache.getOrLoad('k', load)).resolves.toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('stores nothing when the load fails', async () => {
    const cache = new MemoryCache<number>({ ttlMs: 1_000 });
    await expect(cache.getOrLoad('k', async () => { throw new Error('down'); })).rejects.toThrow('down');
    await expect(cache.getOrLoad('k', async () => 7)).resolves.toBe(7);
  });

  it('reloads after a write invalidated the cache', async () => {
    const cache = new MemoryCache<number>({ ttlMs: 60_000 });
    let version = 1;
    const load = async () => version;
    await expect(cache.getOrLoad('k', load)).resolves.toBe(1);
    version = 2;
    cache.clear();
    await expect(cache.getOrLoad('k', load)).resolves.toBe(2);
  });

  it('does not store a load the invalidation overtook', async () => {
    const cache = new MemoryCache<number>({ ttlMs: 60_000 });
    let finish: (value: number) => void = () => undefined;
    const stale = cache.getOrLoad('k', () => new Promise<number>((resolve) => { finish = resolve; }));
    cache.clear();
    finish(1);
    await expect(stale).resolves.toBe(1);
    expect(cache.get('k')).toBeUndefined();
  });

  it('drops one key or a prefix', () => {
    const cache = new MemoryCache<string>({ ttlMs: 60_000 });
    cache.set(callerKey(2, 'directory'), 'two');
    cache.set(callerKey(2, 'assignable', 5), 'two-5');
    cache.set(callerKey(3, 'directory'), 'three');
    cache.delete(callerKey(3, 'directory'));
    expect(cache.get(callerKey(3, 'directory'))).toBeUndefined();
    cache.delete(callerKey(2), { prefix: true });
    expect(cache.size).toBe(0);
  });

  it('keys an answer by caller so it is never served to another one', () => {
    expect(callerKey(2, 'directory')).toBe('user:2:directory');
    expect(callerKey(2, 'a', 1)).not.toBe(callerKey(21, 'a'));
  });

  it('drops the oldest entry beyond maxEntries', () => {
    const cache = new MemoryCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 3);
    cache.set('c', 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(3);
    expect(cache.get('c')).toBe(4);
  });

  it('refuses a TTL that is not positive', () => {
    expect(() => new MemoryCache({ ttlMs: 0 })).toThrow(RangeError);
  });
});
