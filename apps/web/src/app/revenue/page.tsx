import type { Metadata } from "next";
import { RevenueDashboard } from "@/components/revenue/RevenueDashboard";

export const metadata: Metadata = { title: "Revenue & Burn" };

export default function RevenuePage() {
  return <RevenueDashboard />;
}
