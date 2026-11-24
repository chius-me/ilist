export interface CacheRecord<T> {
  value: T;
  storedAt: number;
}

export class DirectoryCache<T> {
  private readonly store = new Map<string, CacheRecord<T>>();

  constructor(
    private readonly maxEntries = 30,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): T | null {
    const record = this.store.get(key);
    if (!record) return null;
    if (this.now() - record.storedAt > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    // Refresh recency for LRU ordering.
    this.store.delete(key);
    this.store.set(key, record);
    return record.value;
  }

  set(key: string, value: T): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, { value, storedAt: this.now() });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  invalidatePrefix(pathPrefix: string): void {
    for (const key of Array.from(this.store.keys())) {
      if (key === pathPrefix || key.startsWith(pathPrefix)) {
        this.store.delete(key);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}
