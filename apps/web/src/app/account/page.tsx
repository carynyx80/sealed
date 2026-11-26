import type { Metadata } from "next";
import { AccountView } from "@/components/custody/AccountView";

export const metadata: Metadata = {
  title: "Account",
  description: "Your Sealed custodial account: balances, deposits, withdrawals and live proof of reserves.",
};

export default function AccountPage() {
  return <AccountView />;
}
