import { ImageResponse } from "next/og";

export const alt = "NIGHTSHIFT — see who answers, know what it costs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The card a shared link renders: brand, the promise, and the live mechanics. */
export default async function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#f7f6f2",
          padding: "60px 72px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 9,
                background: "#16181d",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="#f7f6f2">
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              </svg>
            </div>
            <div style={{ display: "flex", fontSize: 21, fontWeight: 700, letterSpacing: 5.5, color: "#16181d" }}>
              NIGHTSHIFT
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              border: "1px solid #e3e0d8",
              borderRadius: 999,
              padding: "8px 16px",
              background: "#ffffff",
              fontSize: 16,
              color: "#4b4f57",
            }}
          >
            <div style={{ width: 7, height: 7, borderRadius: 999, background: "#0f766e" }} />
            Telegraph network · live
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 78, fontWeight: 700, letterSpacing: -2.6, lineHeight: 1.03, color: "#16181d" }}>
            See who answers.
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 78,
              fontWeight: 700,
              letterSpacing: -2.6,
              lineHeight: 1.03,
              color: "#92400e",
            }}
          >
            Know what it costs.
          </div>
          <div style={{ display: "flex", marginTop: 22, fontSize: 27, lineHeight: 1.4, color: "#4b4f57", maxWidth: 920 }}>
            A live explorer and terminal for the Telegraph network. Ask one question, approve the price, keep the
            receipt.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: "1px solid #e3e0d8",
            paddingTop: 22,
            fontSize: 19,
            color: "#4b4f57",
          }}
        >
          <div style={{ display: "flex", gap: 22 }}>
            <span>0.01 USDC per ask</span>
            <span>·</span>
            <span>Settled on-chain</span>
            <span>·</span>
            <span>Receipt you can verify</span>
          </div>
          <div style={{ display: "flex", color: "#16181d", fontWeight: 600 }}>nightshift-telegraph.vercel.app</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
