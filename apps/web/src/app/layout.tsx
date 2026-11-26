import type { Metadata, Viewport } from "next";
import { Fragment_Mono, Libre_Caslon_Text, Schibsted_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { SolanaProviders } from "@/components/wallet/SolanaProviders";
import { NavBar } from "@/components/layout/NavBar";
import { Footer } from "@/components/layout/Footer";
import { MotionProvider } from "@/components/motion/MotionProvider";
import { SITE_DESCRIPTION, SITE_KEYWORDS, SITE_NAME, SITE_TITLE, SITE_URL, SOCIAL } from "@/lib/site";
import "./globals.css";

// Type system (see /DESIGN.md): Schibsted Grotesk for headlines + UI, Libre Caslon italic for sparse accents, Fragment Mono for every number.
const display = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const serif = Libre_Caslon_Text({ subsets: ["latin"], weight: ["400"], style: ["italic"], variable: "--font-serif", display: "swap" });
const mono = Fragment_Mono({ subsets: ["latin"], weight: "400", variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_TITLE, template: "%s · Sealed" },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: SITE_KEYWORDS,
  // No root canonical: a layout-level canonical is inherited by every page and would point them all at "/". Pages set their own.
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: SITE_URL,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: SOCIAL.locale,
    images: [{ url: SOCIAL.ogImage, width: 1200, height: 630, alt: SOCIAL.ogImageAlt }],
  },
  twitter: { card: SOCIAL.twitterCard, title: SITE_TITLE, description: SITE_DESCRIPTION, images: [SOCIAL.ogImage] },
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }], shortcut: "/icon.svg", apple: "/icon.svg" },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large" } },
};

export const viewport: Viewport = { themeColor: "#F1EFE9", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${serif.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-paper font-sans text-ink">
        <MotionProvider>
          <SolanaProviders>
            <NavBar />
            <main className="mx-auto w-full max-w-7xl px-4 sm:px-6">{children}</main>
            <Footer />
          </SolanaProviders>
        </MotionProvider>
      </body>
    </html>
  );
}
