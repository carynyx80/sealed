import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DocsShell } from "@/components/docs/DocsShell";

export const metadata: Metadata = {
  title: { default: "Docs", template: "%s · Sealed docs" },
  description: "How Sealed works: sealed-bid launches, the fee-credit buyback vault, the holder flywheel, custody, privacy, API and deployment.",
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <DocsShell>{children}</DocsShell>;
}
