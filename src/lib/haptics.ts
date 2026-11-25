/**
 * Haptic feedback for supported browsers (Android Chrome/Edge/Firefox; iOS
 * Safari does not implement navigator.vibrate — every call is a silent no-op
 * there, so callers never need a capability check).
 *
 * The user can turn this off in Settings; the preference persists in
 * localStorage and defaults to on.
 */

export type HapticPattern = "select" | "success" | "error" | "payment" | "notify";

const PATTERNS: Record<HapticPattern, number | number[]> = {
  // Light tick: taps, selections, copy.
  select: 10,
  // A result or answer arrived.
  success: [20, 60, 20],
  // Something failed — a heavier double knock then pause.
  error: [50, 60, 50, 60, 120],
  // Money moved: distinct triple pulse so spending is felt, not just seen.
  payment: [30, 50, 30, 50, 30],
  // Attention: run needs the human (approval gate).
  notify: [15, 40, 15, 40, 15, 40, 15],
};

const STORAGE_KEY = "nightshift.haptics";

// Module-level fallback so the switch works even where localStorage does not
// (SSR, node tests, private-mode browsers).
let fallbackEnabled = true;

export function hapticsSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

export function hapticsEnabled(): boolean {
  if (typeof window === "undefined") return fallbackEnabled;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return fallbackEnabled;
  }
}

export function setHapticsEnabled(enabled: boolean): void {
  fallbackEnabled = enabled;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    /* private mode: the toggle just won't persist */
  }
}

/** Fire a haptic pulse. Safe to call anywhere: server, unsupported browser, or disabled — all no-ops. */
export function vibrate(pattern: HapticPattern): void {
  if (!hapticsSupported() || !hapticsEnabled()) return;
  try {
    navigator.vibrate(PATTERNS[pattern]);
  } catch {
    /* a browser may throw on exotic patterns; feedback must never crash a click */
  }
}
