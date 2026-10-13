/**
 * Parallel upstream calls (MAIR-525): independent calls start together instead of one `await` after the
 * other, with a bound on how many are in flight so a long list does not flood an API.
 */

/** Default number of calls in flight for `mapWithConcurrency` and `readOffsetPages`. */
export const DEFAULT_CONCURRENCY = 5;

/**
 * `Promise.all` over `items` with at most `limit` calls of `task` in flight; results keep the order of
 * `items`. The first failure rejects the whole call, like `Promise.all` (calls already started still run).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`Invalid concurrency limit: ${limit}`);
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        // Each worker runs its share one call at a time: the bound on calls in flight is the point.
        // eslint-disable-next-line no-await-in-loop
        results[index] = await task(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface OffsetPagesOptions<P> {
  /** Reads the page starting at `offset`. */
  fetchPage: (offset: number) => Promise<P>;
  /** Number of items the page holds. */
  served: (page: P) => number;
  /** Total number of items of the list, as the page reports it. */
  total: (page: P) => number;
  /** Pages read at the same time after the first one. Default `DEFAULT_CONCURRENCY`. */
  concurrency?: number;
  /** Upper bound on the number of pages read, first one included. Default 100. */
  maxPages?: number;
}

/**
 * Every page of an offset-paginated list. The first page gives the total and the page size the upstream
 * actually served; the other pages are then read in parallel (at most `concurrency` at a time) instead of
 * one after the other. Pages come back in order. A page that brings no item ends the list there, so a list
 * that shrinks while being read cannot add holes.
 */
export async function readOffsetPages<P>(options: OffsetPagesOptions<P>): Promise<P[]> {
  const first = await options.fetchPage(0);
  const size = options.served(first);
  const total = options.total(first);
  if (size <= 0 || size >= total) return [first];

  const maxPages = options.maxPages ?? 100;
  const offsets: number[] = [];
  for (let offset = size; offset < total && offsets.length + 1 < maxPages; offset += size) offsets.push(offset);
  const rest = await mapWithConcurrency(offsets, options.concurrency ?? DEFAULT_CONCURRENCY, (offset) => options.fetchPage(offset));

  const pages: P[] = [first];
  for (const page of rest) {
    if (options.served(page) === 0) break;
    pages.push(page);
  }
  return pages;
}
