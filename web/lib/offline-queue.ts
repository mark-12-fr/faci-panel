"use client";
// ── Offline submit queue ─────────────────────────────────────────────────────
// Facilitators often mark attendance / enter scores in classrooms with weak or
// no signal. When a submit can't reach the server, we stash it in localStorage
// and replay it automatically once the connection is back (on the `online`
// event and on next app load), so their work is never lost to a dropped signal.

import { apiPost } from "./api";

export type QueuedJob = { id: string; path: string; body: any; label: string; ts: number };

const KEY = "faci_offline_queue";

const read = (): QueuedJob[] => {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};
const write = (jobs: QueuedJob[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(jobs));
  } catch {}
};

/** True when the browser reports itself offline. */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** A thrown value with no numeric `status` is a network failure, not an HTTP rejection. */
export function isNetworkError(e: any): boolean {
  return !(e && typeof e.status === "number");
}

export function enqueue(path: string, body: any, label: string): void {
  const jobs = read();
  jobs.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, path, body, label, ts: Date.now() });
  write(jobs);
}

export function queuedCount(): number {
  return read().length;
}

/** Replay queued jobs oldest-first. Stops on a network/5xx error (still down —
 *  try again later); drops a job only on a definitive 4xx (the server saw it and
 *  rejected it, so retrying can't help). */
export async function flushQueue(): Promise<{ synced: number; remaining: number }> {
  let jobs = read();
  let synced = 0;
  while (jobs.length) {
    const job = jobs[0];
    try {
      await apiPost(job.path, job.body);
      jobs = jobs.slice(1);
      write(jobs);
      synced++;
    } catch (e: any) {
      const status = e?.status;
      if (isNetworkError(e) || (status && status >= 500)) break; // still down → keep & retry later
      jobs = jobs.slice(1); // 4xx → definitively rejected, drop so it can't wedge the queue
      write(jobs);
    }
  }
  return { synced, remaining: jobs.length };
}

/** Flush now and whenever the connection returns. Returns an unsubscribe fn. */
export function startAutoFlush(onSync?: (synced: number) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const run = async () => {
    if (isOffline()) return;
    const { synced } = await flushQueue();
    if (synced && onSync) onSync(synced);
  };
  window.addEventListener("online", run);
  run();
  return () => window.removeEventListener("online", run);
}
