// ── Facilitator session (client-side) ──────────────────────────────────────
// Same localStorage keys the legacy app used, so behaviour (auto-login,
// "remember me", cached name/section/subject) is identical — plus a JWT that
// the FastAPI backend issues on login.

export interface FaciInfo {
  id: string;
  full_name?: string | null;
  section?: string | null;
  subject?: string | null;
  teacher_id?: string | null;
  avatar_url?: string | null;
}

const FACI_KEYS = [
  "faci_token",
  "faci_id",
  "faci_name",
  "faci_section",
  "faci_subject",
  "faci_teacher_id",
  "faci_img_url",
];

const hasWindow = () => typeof window !== "undefined";

export function getItem(key: string): string | null {
  return hasWindow() ? window.localStorage.getItem(key) : null;
}

export function setItem(key: string, value: string) {
  if (hasWindow()) window.localStorage.setItem(key, value);
}

export function removeItem(key: string) {
  if (hasWindow()) window.localStorage.removeItem(key);
}

export function getToken(): string | null {
  return getItem("faci_token");
}

export function isLoggedIn(): boolean {
  return !!getItem("faci_id") && !!getItem("faci_token");
}

export function saveSession(faci: FaciInfo, token: string) {
  // Clear any teacher session data to avoid conflicts (as the old login did).
  ["access_token", "user_id", "cached_user_name", "cached_user_avatar"].forEach(removeItem);

  setItem("faci_token", token);
  setItem("faci_id", String(faci.id));
  setItem("faci_name", faci.full_name || "");
  setItem("faci_section", faci.section || "");
  setItem("faci_subject", faci.subject || "");
  if (faci.teacher_id) setItem("faci_teacher_id", String(faci.teacher_id));
  else removeItem("faci_teacher_id");
  if (faci.avatar_url) setItem("faci_img_url", faci.avatar_url);
}

export function clearSession() {
  FACI_KEYS.forEach(removeItem);
}
