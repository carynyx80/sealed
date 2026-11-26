import type { Metadata } from "next";
import { LaunchWizard } from "@/components/launch/LaunchWizard";

export const metadata: Metadata = { title: "Launch Studio" };

export default function LaunchPage() {
  return <LaunchWizard />;
}
