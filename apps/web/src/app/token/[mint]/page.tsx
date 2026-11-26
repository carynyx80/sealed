import type { Metadata } from "next";
import { TokenRoom } from "@/components/token/TokenRoom";

export const metadata: Metadata = { title: "Token Room" };

export default async function TokenPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  return <TokenRoom idOrMint={decodeURIComponent(mint)} />;
}
