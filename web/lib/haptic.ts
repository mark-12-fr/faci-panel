"use client";
// Tiny haptic tap. A short vibration confirms a mark/save registered, so a
// facilitator tapping quickly down a roster doesn't have to visually double-check
// each one. No-ops where the device / browser doesn't support vibration.
export function haptic(pattern: number | number[] = 12): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch {}
}
