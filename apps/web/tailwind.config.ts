import type { Config } from "tailwindcss";

/**
 * Sealed design tokens — "private-bank broadsheet". See /DESIGN.md.
 * New semantic names are canonical. Legacy keys (cream, linen, hairline, emerald, terracotta) are kept as
 * aliases that point at the NEW values so un-migrated components still render on-system; migrate them away.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: { DEFAULT: "#F1EFE9", deep: "#E8E5DC" },
        sheet: "#FCFBF8",
        rule: { DEFAULT: "#DEDAD1", strong: "#C9C4B8" },
        ink: { DEFAULT: "#0F0F0D", soft: "#2A2926", slate: "#5C5A54", muted: "#8F8C84" },
        signal: { DEFAULT: "#2E3FE0", deep: "#1F2BA8", tint: "#E9ECFF", ink: "#141B6B", bright: "#8C97FF" },
        gain: { DEFAULT: "#0A7D52", tint: "#E3F2EA", bright: "#3DD69B" },
        burn: { DEFAULT: "#D7263D", tint: "#FBE6E8", bright: "#FF6B7D" },
        night: { DEFAULT: "#0F0F0D", raised: "#1A1A17", rule: "#2E2D29", text: "#EDEBE4", muted: "#8F8C84" },
        // legacy aliases → new values
        cream: "#F1EFE9",
        linen: "#E8E5DC",
        hairline: { DEFAULT: "#DEDAD1", hover: "#C9C4B8" },
        emerald: { DEFAULT: "#0A7D52", tint: "#E3F2EA" },
        terracotta: { DEFAULT: "#D7263D", tint: "#FBE6E8" },
      },
      fontFamily: {
        display: ["var(--font-display)", "Helvetica Neue", "Arial", "sans-serif"],
        sans: ["var(--font-display)", "Helvetica Neue", "Arial", "sans-serif"],
        serif: ["var(--font-serif)", "Georgia", "serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      fontSize: {
        "display-xl": ["clamp(3rem, 8.5vw, 7.5rem)", { lineHeight: "0.92", letterSpacing: "-0.045em", fontWeight: "700" }],
        "display-lg": ["clamp(2.25rem, 5vw, 4.25rem)", { lineHeight: "0.98", letterSpacing: "-0.04em", fontWeight: "700" }],
        "display-md": ["clamp(1.75rem, 3vw, 2.5rem)", { lineHeight: "1.05", letterSpacing: "-0.03em", fontWeight: "650" }],
        "display-sm": ["1.375rem", { lineHeight: "1.15", letterSpacing: "-0.02em", fontWeight: "600" }],
      },
      borderRadius: { card: "14px", field: "10px", "4xl": "2rem" },
      boxShadow: {
        card: "0 1px 0 rgba(15,15,13,0.04)",
        lift: "0 1px 0 rgba(15,15,13,0.04), 0 18px 40px -18px rgba(15,15,13,0.18)",
        focus: "0 0 0 4px rgba(46,63,224,0.14)",
      },
      keyframes: {
        pulseSoft: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.45" } },
        dash: { to: { strokeDashoffset: "-24" } },
        ring: { to: { transform: "rotate(360deg)" } },
        ringRev: { to: { transform: "rotate(-360deg)" } },
        blink: { "0%,49%": { opacity: "1" }, "50%,100%": { opacity: "0" } },
      },
      animation: {
        "pulse-soft": "pulseSoft 1s ease-in-out infinite",
        dash: "dash 1.2s linear infinite",
        ring: "ring 24s linear infinite",
        "ring-slow": "ring 60s linear infinite",
        "ring-rev": "ringRev 40s linear infinite",
        blink: "blink 1.1s steps(1) infinite",
      },
      maxWidth: { measure: "34rem" },
    },
  },
  plugins: [],
};
export default config;
