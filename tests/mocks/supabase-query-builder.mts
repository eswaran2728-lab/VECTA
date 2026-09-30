/**
 * Minimal, purpose-built Supabase query-builder mock for Phase 8
 * application-level authorization tests. Not a generic Supabase client
 * mock -- it implements only the chain shapes the specific server
 * actions under test actually call, and resolves them from a per-test
 * FIFO queue of results, so each test controls exactly what the "next"
 * .from(...)... / .rpc(...) call resolves to.
 *
 * This is deliberately the minimum viable infrastructure: no new
 * dependency, reuses node:test's built-in module mocking
 * (--experimental-test-module-mocks), matching this repo's existing
 * "plain node:test, no framework" convention.
 */

export interface QueuedResult {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

export class ResultQueue {
  private queue: QueuedResult[] = [];
  private calls: { kind: string; args: unknown[] }[] = [];

  push(result: QueuedResult) {
    this.queue.push(result);
    return this;
  }

  next(): QueuedResult {
    const r = this.queue.shift();
    if (!r) throw new Error("ResultQueue exhausted -- test did not queue enough results for the calls made.");
    return r;
  }

  record(kind: string, args: unknown[]) {
    this.calls.push({ kind, args });
  }

  getCalls() {
    return this.calls;
  }

  callsMatching(kind: string) {
    return this.calls.filter((c) => c.kind === kind);
  }
}

function makeChainable(queue: ResultQueue, tableName: string) {
  const chain: Record<string, unknown> & { then: (resolve: (v: QueuedResult) => void, reject?: (e: unknown) => void) => void } = {
    from: () => chain,
    select: (...args: unknown[]) => {
      queue.record("select", [tableName, ...args]);
      return chain;
    },
    update: (...args: unknown[]) => {
      queue.record("update", [tableName, ...args]);
      return chain;
    },
    insert: (...args: unknown[]) => {
      queue.record("insert", [tableName, ...args]);
      return chain;
    },
    eq: (...args: unknown[]) => {
      queue.record("eq", [tableName, ...args]);
      return chain;
    },
    is: (...args: unknown[]) => {
      queue.record("is", [tableName, ...args]);
      return chain;
    },
    lte: (...args: unknown[]) => {
      queue.record("lte", [tableName, ...args]);
      return chain;
    },
    gte: (...args: unknown[]) => {
      queue.record("gte", [tableName, ...args]);
      return chain;
    },
    or: (...args: unknown[]) => {
      queue.record("or", [tableName, ...args]);
      return chain;
    },
    in: (...args: unknown[]) => {
      queue.record("in", [tableName, ...args]);
      return chain;
    },
    single: () => {
      queue.record("single", [tableName]);
      return chain;
    },
    maybeSingle: () => {
      queue.record("maybeSingle", [tableName]);
      return chain;
    },
    // Every chain is awaitable at any point (mirrors real supabase-js
    // PostgrestFilterBuilder's thenable behavior) -- resolves the next
    // queued result regardless of which method was called last.
    then: (resolve: (v: QueuedResult) => void) => {
      resolve(queue.next());
    },
  };
  return chain;
}

export function makeMockSupabaseClient(queue: ResultQueue) {
  return {
    from: (tableName: string) => {
      queue.record("from", [tableName]);
      return makeChainable(queue, tableName);
    },
    rpc: (fnName: string, args?: unknown) => {
      queue.record("rpc", [fnName, args]);
      const result = queue.next();
      return {
        then: (resolve: (v: QueuedResult) => void) => resolve(result),
        single: () => ({
          then: (resolve: (v: QueuedResult) => void) => resolve(result),
        }),
      };
    },
    auth: {
      getUser: async () => queue.next(),
    },
    storage: {
      from: () => ({
        upload: async () => queue.next(),
        remove: async () => queue.next(),
        createSignedUrl: async () => queue.next(),
      }),
    },
  };
}
