import { renderOgImage } from "@/lib/ogImage";

export const alt = "Sealed — Sealed-Block Launchpad on Solana";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return renderOgImage();
}
