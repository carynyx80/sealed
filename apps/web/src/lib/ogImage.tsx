import { ImageResponse } from "next/og";
import { BRAND, SITE_HOST, SITE_TAGLINE } from "./site";

/** Shared OG/Twitter card renderer. Self-contained: no runtime font or asset fetches; system sans stands in for Schibsted Grotesk. */
export const OG_SIZE = { width: 1200, height: 630 };

function SealRing({ px }: { px: number }) {
  return (
    <svg width={px} height={px} viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="15" stroke={BRAND.ink} strokeWidth="0.6" />
      <circle cx="16" cy="16" r="10.5" stroke={BRAND.ultramarine} strokeWidth="0.6" strokeDasharray="1.2 1.2" />
      <circle cx="16" cy="16" r="5" fill={BRAND.ink} />
      <path d="M1 16h9M22 16h9" stroke={BRAND.ink} strokeWidth="0.6" />
    </svg>
  );
}

export function renderOgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: BRAND.paper,
          color: BRAND.ink,
          padding: "72px 80px",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, Helvetica, Arial, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <SealRing px={64} />
            <div style={{ fontSize: 44, fontWeight: 700, letterSpacing: -1 }}>Sealed</div>
          </div>
          <div style={{ display: "flex", fontSize: 22, letterSpacing: 3, textTransform: "uppercase", color: BRAND.ultramarine }}>Solana</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 48 }}>
          <div style={{ display: "flex", flexDirection: "column", maxWidth: 720 }}>
            <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.02, letterSpacing: -3 }}>Every bid sealed.</div>
            <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.02, letterSpacing: -3, color: BRAND.ultramarine }}>One clearing price.</div>
            <div style={{ fontSize: 28, marginTop: 28, lineHeight: 1.35, opacity: 0.75 }}>
              {SITE_TAGLINE}: day-one fee-credit buybacks, auto-repay, permanent holder flywheel.
            </div>
          </div>
          <SealRing px={300} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${BRAND.ink}`, paddingTop: 22, fontSize: 22 }}>
          <div style={{ display: "flex" }}>{SITE_HOST}</div>
          <div style={{ display: "flex", opacity: 0.6 }}>Commit · Reveal · Clear · Burn</div>
        </div>
      </div>
    ),
    OG_SIZE,
  );
}

