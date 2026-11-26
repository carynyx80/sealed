/** Canonical site identity: production domain, name and social defaults used by metadata, sitemap, robots and OG images. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.sealedsol.xyz").replace(/\/$/, "");
export const SITE_HOST = new URL(SITE_URL).host;
export const SITE_NAME = "Sealed";
export const SITE_TAGLINE = "Sealed-Block Launchpad on Solana";
export const SITE_TITLE = `${SITE_NAME} — ${SITE_TAGLINE}`;
export const SITE_DESCRIPTION =
  "Sealed-bid token launches on Solana with one uniform clearing price, day-one fee-credit buybacks, auto-repay and a permanent holder flywheel.";
export const SITE_KEYWORDS = ["Solana", "launchpad", "sealed-bid auction", "commit-reveal", "uniform price", "buyback", "token launch", "flywheel"];

/** Brand colours (see /DESIGN.md). */
export const BRAND = { paper: "#F1EFE9", ink: "#0F0F0D", ultramarine: "#2E3FE0" } as const;

export const SOCIAL = {
  ogImage: "/opengraph-image",
  ogImageAlt: SITE_TITLE,
  twitterCard: "summary_large_image" as const,
  locale: "en_US",
};

/** Static, indexable routes (token pages are dynamic and excluded). */
export const STATIC_ROUTES = ["/", "/launch", "/revenue", "/account", "/docs"] as const;
