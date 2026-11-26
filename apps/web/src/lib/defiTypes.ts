/** Types derived from the defi hooks' signatures (robust to how the defi agent exports them). */
import type { useSealedBid } from "./defi/useSealedBid";

type SealedBidApi = ReturnType<typeof useSealedBid>;
export type CommitArgs = Parameters<SealedBidApi["commit"]>[0];
export type CommitResult = Awaited<ReturnType<SealedBidApi["commit"]>>;
export type SealedBidStatus = SealedBidApi["status"];
