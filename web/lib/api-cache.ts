// ── Simple in-memory + sessionStorage API cache ──────────────────────────────
// Provides stale-while-revalidate: show cached data instantly, fetch fresh data
// in the background, and update state when it arrives. This makes page loads
// feel instant after the first visit.

const CACHE_PREFIX = "faci_api_cache_";
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const memCache = new Map<string, CacheEntry<any>>();

function readCache<T>(key: string): T | null {
  // Memory cache is fastest
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.ts < MAX_AGE_MS) return mem.data as T;

  // Fall back to sessionStorage for persistence across soft navigations
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key);
    if (raw) {
      const entry: CacheEntry<T> = JSON.parse(raw);
      if (Date.now() - entry.ts < MAX_AGE_MS) {
        memCache.set(key, entry);
        return entry.data;
      }
    }
  } catch {}
  return null;
}

function writeCache<T>(key: string, data: T) {
  const entry: CacheEntry<T> = { data, ts: Date.now() };
  memCache.set(key, entry);
  try {
    sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
  } catch {}
}

export function clearCache(key?: string) {
  if (key) {
    memCache.delete(key);
    sessionStorage.removeItem(CACHE_PREFIX + key);
  } else {
    memCache.clear();
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(CACHE_PREFIX))
      .forEach((k) => sessionStorage.removeItem(k));
  }
}

export function getCached<T>(key: string): T | null {
  return readCache<T>(key);
}

export function setCache<T>(key: string, data: T) {
  writeCache(key, data);
}

export interface CacheResult<T> {
  data: T | null;
  loading: boolean;
  refresh: () => void;
}

/**
 * Returns cached data if available. The caller decides how to use it:
 * - If `cachedData` is non-null, show it immediately
 * - Always fetch fresh data in the background
 * - When fresh data arrives, update the state
 */
export function getCacheKey(...parts: (string | number | undefined)[]): string {
  return parts.filter(Boolean).join(":");
}
