export class LoadFailure extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  weight: number;
}

export interface TtlCacheOptions<V> {
  ttlMs: number;
  maxWeight: number;
  weigh?: (value: V) => number;
  now?: () => number;
}

export class TtlCache<K, V> {
  readonly #entries = new Map<K, CacheEntry<V>>();
  readonly #pending = new Map<K, Promise<V>>();
  readonly #ttlMs: number;
  readonly #maxWeight: number;
  readonly #weigh: (value: V) => number;
  readonly #now: () => number;
  #weight = 0;

  constructor({ ttlMs, maxWeight, weigh = () => 1, now = Date.now }: TtlCacheOptions<V>) {
    this.#ttlMs = ttlMs;
    this.#maxWeight = maxWeight;
    this.#weigh = weigh;
    this.#now = now;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): void {
    this.delete(key);
    const weight = Math.max(1, Math.ceil(this.#weigh(value)));
    if (weight > this.#maxWeight) return;
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs, weight });
    this.#weight += weight;
    for (const [oldest, entry] of this.#entries) {
      if (this.#weight <= this.#maxWeight) break;
      this.#entries.delete(oldest);
      this.#weight -= entry.weight;
    }
  }

  delete(key: K): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key);
    this.#weight -= entry.weight;
  }

  clear(): void {
    this.#entries.clear();
    this.#pending.clear();
    this.#weight = 0;
  }

  load(key: K, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const request = (async () => {
      try {
        const value = await loader();
        this.set(key, value);
        return value;
      } finally {
        this.#pending.delete(key);
      }
    })();
    this.#pending.set(key, request);
    return request;
  }
}

export function jsonWeight(value: unknown): number {
  if (value === null || typeof value === "boolean" || value === undefined) return 1;
  if (typeof value === "number") return 16;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += jsonWeight(item);
    return total + 16;
  }
  if (typeof value === "object") {
    let total = 0;
    for (const [key, item] of Object.entries(value)) total += key.length + jsonWeight(item);
    return total + 16;
  }
  return 16;
}

export interface GateSnapshot {
  active: number;
  limit: number;
  minimum: number;
  maximum: number;
  peak: number;
  waits: number;
  rejected: number;
}

export class Gate {
  readonly #limit: number;
  readonly #waiting: Array<() => void> = [];
  #active = 0;
  #peak = 0;
  #waits = 0;
  #rejected = 0;

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  snapshot(): GateSnapshot {
    return {
      active: this.#active,
      limit: this.#limit,
      minimum: 1,
      maximum: this.#limit,
      peak: this.#peak,
      waits: this.#waits,
      rejected: this.#rejected,
    };
  }

  async run<T>(timeoutMs: number, task: () => Promise<T>): Promise<T> {
    await this.#acquire(timeoutMs);
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(timeoutMs: number): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      this.#peak = Math.max(this.#peak, this.#active);
      return Promise.resolve();
    }
    this.#waits += 1;
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        this.#active += 1;
        this.#peak = Math.max(this.#peak, this.#active);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.#waiting.indexOf(grant);
        if (index >= 0) this.#waiting.splice(index, 1);
        this.#rejected += 1;
        reject(new LoadFailure("capacity"));
      }, timeoutMs);
      this.#waiting.push(grant);
    });
  }

  #release(): void {
    this.#active -= 1;
    this.#waiting.shift()?.();
  }
}

export function requestSlot(intervalMs: number, now: () => number = Date.now) {
  let next = 0;
  return async () => {
    const current = now();
    const wait = Math.max(0, next - current);
    next = Math.max(current, next) + intervalMs;
    if (wait > 0) await Bun.sleep(wait);
  };
}

export async function withTimeout<T>(timeoutMs: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new LoadFailure("timeout")), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function hedgedCount(
  primary: Promise<number>,
  fallback: () => Promise<number>,
  headStartMs: number,
): Promise<number> {
  const safePrimary = primary.catch(() => 0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const early = await Promise.race([
    safePrimary.then((count) => ({ count })),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), headStartMs);
    }),
  ]);
  clearTimeout(timer);
  if (early) return early.count > 0 ? early.count : fallback().catch(() => 0);
  const safeFallback = fallback().catch(() => 0);
  const first = await Promise.race([
    safePrimary.then((count) => ({ from: "primary" as const, count })),
    safeFallback.then((count) => ({ from: "fallback" as const, count })),
  ]);
  if (first.count > 0) return first.count;
  return first.from === "primary" ? safeFallback : safePrimary;
}
