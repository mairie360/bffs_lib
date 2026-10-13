import { mapWithConcurrency, readOffsetPages } from '../src';

/** A deferred task: resolves when the test says so, and records when it started. */
function controlled() {
  const started: number[] = [];
  const release = new Map<number, () => void>();
  const task = (item: number) => new Promise<number>((resolve) => {
    started.push(item);
    release.set(item, () => resolve(item * 10));
  });
  return { started, release, task };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('mapWithConcurrency (MAIR-525)', () => {
  it('starts at most `limit` calls at once and keeps the order of the items', async () => {
    const { started, release, task } = controlled();
    const done = mapWithConcurrency([1, 2, 3, 4], 2, task);
    await flush();
    expect(started).toEqual([1, 2]);
    release.get(2)?.();
    await flush();
    expect(started).toEqual([1, 2, 3]);
    release.get(1)?.();
    release.get(3)?.();
    await flush();
    release.get(4)?.();
    await expect(done).resolves.toEqual([10, 20, 30, 40]);
  });

  it('starts every call together when the limit allows it', async () => {
    const { started, release, task } = controlled();
    const done = mapWithConcurrency([1, 2, 3], 10, task);
    await flush();
    expect(started).toEqual([1, 2, 3]);
    release.forEach((resolve) => resolve());
    await expect(done).resolves.toEqual([10, 20, 30]);
  });

  it('answers an empty list without calling the task', async () => {
    const task = jest.fn();
    await expect(mapWithConcurrency([], 3, task)).resolves.toEqual([]);
    expect(task).not.toHaveBeenCalled();
  });

  it('rejects on the first failure and starts no new call after it', async () => {
    const task = jest.fn(async (item: number) => {
      if (item === 1) throw new Error('boom');
      return item;
    });
    await expect(mapWithConcurrency([1, 2, 3, 4], 1, task)).rejects.toThrow('boom');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('refuses an invalid limit', async () => {
    await expect(mapWithConcurrency([1], 0, async (item) => item)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1], 1.5, async (item) => item)).rejects.toThrow(RangeError);
  });
});

type Page = { items: number[]; total: number };

/** A list of `total` items served `size` at a time, recording the offsets asked. */
function list(total: number, size: number) {
  const offsets: number[] = [];
  const fetchPage = jest.fn(async (offset: number): Promise<Page> => {
    offsets.push(offset);
    const items = Array.from({ length: Math.max(0, Math.min(size, total - offset)) }, (_, i) => offset + i);
    return { items, total };
  });
  return { offsets, fetchPage, served: (page: Page) => page.items.length, total: (page: Page) => page.total };
}

describe('readOffsetPages (MAIR-525)', () => {
  it('reads a one-page list in one call', async () => {
    const source = list(3, 10);
    const pages = await readOffsetPages(source);
    expect(pages).toHaveLength(1);
    expect(source.fetchPage).toHaveBeenCalledTimes(1);
  });

  it('reads an empty list in one call', async () => {
    const source = list(0, 10);
    await expect(readOffsetPages(source)).resolves.toHaveLength(1);
    expect(source.fetchPage).toHaveBeenCalledTimes(1);
  });

  it('steps by the size the upstream served and starts the other pages together', async () => {
    const source = list(25, 10);
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchPage = async (offset: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await flush();
      inFlight -= 1;
      return source.fetchPage(offset);
    };
    const pages = await readOffsetPages({ ...source, fetchPage });
    expect(source.offsets).toEqual([0, 10, 20]);
    expect(pages.flatMap((page) => page.items)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(maxInFlight).toBe(2);
  });

  it('bounds the pages in flight and the pages read', async () => {
    const source = list(100, 10);
    const pages = await readOffsetPages({ ...source, concurrency: 3, maxPages: 4 });
    expect(pages).toHaveLength(4);
    expect(source.offsets).toEqual([0, 10, 20, 30]);
  });

  it('stops at the first empty page of a list that shrank while being read', async () => {
    const fetchPage = jest.fn(async (offset: number): Promise<Page> => (
      offset === 0 ? { items: [0, 1], total: 6 } : offset === 2 ? { items: [], total: 2 } : { items: [offset], total: 2 }
    ));
    const pages = await readOffsetPages({ fetchPage, served: (page) => page.items.length, total: (page) => page.total });
    expect(pages.flatMap((page) => page.items)).toEqual([0, 1]);
  });
});
