"use client";
// Owned by web-offchain-agent. Mount once (NavBar); renders whichever custody sheet is open.
import { closeSheet, useSheetState } from "@/lib/custody/sheets";
import { DepositSheet } from "./DepositSheet";
import { WithdrawSheet } from "./WithdrawSheet";

export function CustodySheets() {
  const s = useSheetState();
  return (
    <>
      <DepositSheet open={s.kind === "deposit"} onClose={closeSheet} asset={s.kind === "deposit" ? s.asset : "SOL"} suggested={s.kind === "deposit" ? s.suggested : undefined} />
      <WithdrawSheet open={s.kind === "withdraw"} onClose={closeSheet} asset={s.kind === "withdraw" ? s.asset : "SOL"} />
    </>
  );
}
