import type { Metadata, Viewport } from "next";
import { Fragment_Mono, Libre_Caslon_Text, Schibsted_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { SolanaProviders } from "@/components/wallet/SolanaProviders";
import { NavBar } from "@/components/layout/NavBar";
import { Footer } from "@/components/layout/Footer";
import { MotionProvider } from "@/components/motion/MotionProvider";
import "./globals.css";

// Type system (see /DESIGN.md): Schibsted Grotesk for headlines + UI, Libre Caslon italic for sparse accents, Fragment Mono for every number.
const display = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const serif = Libre_Caslon_Text({ subsets: ["latin"], weight: ["400"], style: ["italic"], variable: "--font-serif", display: "swap" });
const mono = Fragment_Mono({ subsets: ["latin"], weight: "400", variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Sealed — Sealed-Block Launchpad on Solana", template: "%s · Sealed" },
  description: "Sealed-bid token launches with day-one fee-credit buybacks, auto-repay and a permanent holder flywheel.",
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
