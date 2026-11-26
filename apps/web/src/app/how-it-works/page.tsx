import type { Metadata } from "next";
import { HowItWorks } from "@/components/howitworks/HowItWorks";
import { SITE_NAME, SITE_URL, SOCIAL } from "@/lib/site";

const TITLE = "How it works";
const DESCRIPTION =
  "How Sealed works, step by step: sign in, deposit SOL or USDC, place a sealed bid, reveal, clear at one price, claim, and watch the day-one buyback vault burn.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/how-it-works" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: `${SITE_URL}/how-it-works`,
    title: `${TITLE} · ${SITE_NAME}`,
    description: DESCRIPTION,
    locale: SOCIAL.locale,
    images: [{ url: SOCIAL.ogImage, width: 1200, height: 630, alt: SOCIAL.ogImageAlt }],
  },
  twitter: { card: SOCIAL.twitterCard, title: `${TITLE} · ${SITE_NAME}`, description: DESCRIPTION, images: [SOCIAL.ogImage] },
};

export default function HowItWorksPage() {
  return <HowItWorks />;
}
