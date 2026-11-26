"use client";
// Perf: the Deposit / Withdraw sheets pull in spl-token, the Anchor client and the privacy-ring UI. They are only
// needed once a sheet is opened (openDeposit / openWithdraw), so they load on first open instead of with every page.
// After the first open they stay mounted, exactly like the eager <CustodySheets /> (close animations included).
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useSheetState } from "@/lib/custody/sheets";

const CustodySheets = dynamic(() => import("./CustodySheets").then((m) => m.CustodySheets), { ssr: false });

export function LazyCustodySheets() {
  const s = useSheetState();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (s.kind !== "none") setLoaded(true);
  }, [s.kind]);
  return loaded || s.kind !== "none" ? <CustodySheets /> : null;
}
