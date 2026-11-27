"use client";

/**
 * Global error boundary — the last-resort catch rendered INSTEAD of the root
 * layout (when the app shell itself fails). It carries its own minimal
 * styling because the layout's CSS may not be present, and its copy keeps
 * the one truth that matters in a commerce app: a rendering failure never
 * moved anyone's money.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0b0f0e", color: "#e7ece9", fontFamily: "system-ui, -apple-system, sans-serif" }}>
        <div style={{ maxWidth: 560, margin: "0 auto", padding: "72px 20px" }} role="alert">
          <p style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#8ba197", margin: 0 }}>NIGHTSHIFT</p>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "10px 0 10px" }}>The application failed to start</h1>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: "#b7c4bd" }}>
            This is a rendering failure in the app shell, not a transaction problem: your wallet, your funds and anything already signed on Base are
            untouched. Reload the page to recover.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={reset}
              style={{ minHeight: 36, padding: "0 14px", borderRadius: 8, border: "1px solid #2a3a33", background: "#14201c", color: "#e7ece9", fontSize: 13 }}
            >
              Try again
            </button>
            <a
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: 36,
                padding: "0 14px",
                borderRadius: 8,
                border: "1px solid #2a3a33",
                color: "#7fd6c2",
                fontSize: 13,
                textDecoration: "none",
              }}
            >
              Go to the home page
            </a>
          </div>
          <p style={{ marginTop: 16, fontSize: 10.5, color: "#6d8378", wordBreak: "break-word" }}>
            {error.message}
            {error.digest ? ` · digest ${error.digest}` : ""}
          </p>
        </div>
      </body>
    </html>
  );
}
