"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy, useSignMessage, useWallets } from "@privy-io/react-auth";
import { LogIn, LogOut, ShieldCheck, Wallet } from "lucide-react";

import { buildUserSignInMessage } from "@/lib/api/signInMessage";

export interface SessionState {
  mode: "operator" | "user" | "anonymous" | "unavailable" | "loading";
  address?: string;
}

/**
 * Wallet sign-in: the user's own in-app wallet IS the credential. Signs the
 * canonical NIGHTSHIFT sign-in message once (personal_sign — not a
 * transaction, nothing moves) and the server answers with an HttpOnly session
 * cookie. No operator token, no shared secret, works for every user.
 */
export function WalletSignIn({ onSession, compact = false }: { onSession?: (s: SessionState) => void; compact?: boolean }) {
  const { authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const [session, setSession] = useState<SessionState>({ mode: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/session", { cache: "no-store" });
      const body = (await res.json()) as { mode?: SessionState["mode"]; address?: string };
      const next: SessionState = { mode: body.mode ?? "anonymous", address: body.address };
      setSession(next);
      onSession?.(next);
    } catch {
      const next: SessionState = { mode: "anonymous" };
      setSession(next);
      onSession?.(next);
    }
    // onSession is intentionally excluded: parents pass stable callbacks and
    // a changing identity here must not retrigger the parent's own fetches.
  }, [onSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = async () => {
    const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
    if (!wallet) {
      setError("Create or connect a wallet first (open Wallet).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const message = buildUserSignInMessage(wallet.address, new Date().toISOString());
      const { signature } = await signMessage(
        { message },
        { address: wallet.address, uiOptions: { showWalletUIs: false } },
      );
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: wallet.address, message, signature }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await fetch("/api/session", { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const label =
    session.mode === "user" && session.address
      ? `${session.address.slice(0, 6)}…${session.address.slice(-4)}`
      : session.mode === "operator"
        ? "operator"
        : null;

  if (compact && label) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-teal">
        <ShieldCheck size={12} aria-hidden /> signed in {label}
      </span>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        {label ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-teal/40 bg-teal/10 px-2.5 py-1 text-[11px] font-medium text-teal">
              <ShieldCheck size={11} aria-hidden />
              Signed in{session.mode === "operator" ? " as operator" : ` as ${label}`}
            </span>
            <button
              type="button"
              onClick={signOut}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-panel px-3 py-1.5 text-[12.5px] text-ink-soft transition-colors hover:border-ink-faint hover:text-ink disabled:opacity-50"
            >
              <LogOut size={13} strokeWidth={1.8} /> {busy ? "…" : "Sign out"}
            </button>
          </>
        ) : (
          <>
            {!authenticated && (
              <button
                type="button"
                onClick={() => void login()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-panel px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:border-teal hover:text-teal"
              >
                <Wallet size={14} strokeWidth={1.8} /> Log in
              </button>
            )}
            {authenticated && (
              <button
                type="button"
                onClick={() => void signIn()}
                disabled={busy || session.mode === "unavailable"}
                className="inline-flex items-center gap-1.5 rounded-lg border border-teal/50 bg-teal/10 px-3 py-2 text-[13px] font-medium text-teal transition-colors hover:bg-teal/20 disabled:opacity-50"
              >
                <LogIn size={14} strokeWidth={1.8} /> {busy ? "Check your wallet…" : "Sign in with your wallet"}
              </button>
            )}
          </>
        )}
      </div>
      {!label && session.mode !== "unavailable" && (
        <p className="text-[11.5px] leading-relaxed text-ink-soft">
          One signature, once per device: it proves this wallet is yours. Not a transaction — no funds move, no gas.
        </p>
      )}
      {session.mode === "unavailable" && (
        <p className="text-[11.5px] leading-relaxed text-amber">
          Sign-in is unavailable on this deployment (no server secret configured).
        </p>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-risk">
          {error}
        </p>
      )}
    </div>
  );
}
