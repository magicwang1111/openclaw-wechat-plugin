export function makeDedupeKey(parts: Array<string | number | undefined | null>) {
  return parts.filter((v) => v !== undefined && v !== null && String(v).length > 0).join(":");
}

export class TTLSeenSet {
  private ttlMs: number;
  private map = new Map<string, number>();

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  seen(key: string) {
    const now = Date.now();
    const exp = this.map.get(key);
    if (exp && exp > now) return true;
    this.map.set(key, now + this.ttlMs);
    // 轻量清理
    if (this.map.size > 2000) {
      for (const [k, v] of this.map) {
        if (v <= now) this.map.delete(k);
      }
    }
    return false;
  }
}
