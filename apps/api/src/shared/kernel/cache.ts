/** Porta de cache. Hoje em memória; trocar por Redis na escala horizontal sem tocar nos módulos. */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

const SWEEP_EVERY = 500;

export class MemoryCache implements Cache {
  private store = new Map<string, { value: unknown; expiresAt: number }>();
  private writes = 0;

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    // chaves com versão/data nunca são relidas depois de vencer: varre de tempos em tempos para a memória não crescer
    if (++this.writes % SWEEP_EVERY === 0) this.sweep();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, hit] of this.store) if (hit.expiresAt < now) this.store.delete(key);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}
