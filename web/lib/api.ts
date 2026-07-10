// ── Authenticated API client ────────────────────────────────────────────────
// Thin fetch wrapper that attaches the facilitator JWT and normalises errors.
// On 401 (missing/expired token) it clears the session and bounces to /login —
// the equivalent of the legacy client's forced re-login.

import { API_BASE } from "./config";
import { clearSession, getToken } from "./session";

export class ApiError extends Error {
  status: number;
  payload: any;
  constructor(message: string, status: number, payload: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

interface ApiOptions extends Omit<RequestInit, "body"> {
  body?: any;
  auth?: boolean; // default true
}

export async function api<T = any>(path: string, options: ApiOptions = {}): Promise<T> {
  const { body, auth = true, headers: extraHeaders, ...rest } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(extraHeaders as Record<string, string>),
  };
  if (auth) {
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let payload: any = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      clearSession();
      if (typeof window !== "undefined") window.location.replace("/login");
    }
    const message =
      (payload && (payload.detail || payload.error)) || `Request failed (${res.status})`;
    throw new ApiError(String(message), res.status, payload);
  }
  return payload as T;
}

export const apiGet = <T = any>(path: string, opts: ApiOptions = {}) =>
  api<T>(path, { ...opts, method: "GET" });

export const apiPost = <T = any>(path: string, body?: any, opts: ApiOptions = {}) =>
  api<T>(path, { ...opts, method: "POST", body });

export const apiPatch = <T = any>(path: string, body?: any, opts: ApiOptions = {}) =>
  api<T>(path, { ...opts, method: "PATCH", body });
