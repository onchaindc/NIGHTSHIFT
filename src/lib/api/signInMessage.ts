/**
 * Client-safe pieces of the wallet sign-in flow (no node imports — this is
 * bundled into the browser). The server-side verifier lives in
 * src/lib/api/auth.ts and re-exports this builder so both sides render the
 * EXACT same string; a template mismatch would make every signature fail.
 */

/** The canonical string a wallet signs to prove ownership. Rendered verbatim in the UI. */
export function buildUserSignInMessage(address: string, isoTime: string): string {
  return [
    "NIGHTSHIFT sign-in",
    `Address: ${address}`,
    `Time: ${isoTime}`,
    "Purpose: prove wallet ownership for a session cookie. Not a transaction. No funds move.",
    "",
  ].join("\n");
}
