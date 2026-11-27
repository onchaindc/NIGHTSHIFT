/**
 * Shared formatting used by BOTH server components and client components.
 *
 * This lives outside taskParts because taskParts is a "use client" module:
 * a server component that imports a VALUE from a client module gets an
 * opaque client reference, and calling it during SSR throws ("attempted to
 * call the default/export ... from the server"). The Overview's activity
 * builder died on exactly that when it called money() server-side. Money and
 * timestamps format identically on both sides of the boundary through this
 * module; client modules may re-export or import it freely.
 */

/** USD cents → "$12.34"; negative cents render as "-$1.00". */
export function money(cents: number) {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** A short shared timestamp, e.g. "Nov 27, 14:05". */
export function timeOf(ts: number) {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
