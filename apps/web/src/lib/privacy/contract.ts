// Owned by privacy-web-agent. Web side of the privacy backend contract. Routes and the payload
// types come from packages/shared (custody.ts / types.ts); this module adds the web-only pieces. Plain module: no SDK
// import, safe for any bundle.
import {
  PRIVACY_ROUTES as SHARED_PRIVACY_ROUTES,
  type PrivacyAsset,
  type PrivacyStatusResponse,
  type PrivateDepositInfo,
  type PrivateDepositRecord,
} from "@sealed/shared";

/** `privateTo` on POST /api/account/withdrawals: the backend resolves it to the account's linked private wallet. */
export const PRIVATE_TO_LINKED = "linked";

export const PRIVACY_ROUTES = {
  ...SHARED_PRIVACY_ROUTES,
  /**
   * Keyed passthrough the browser SDK needs for the Helius SPR gateway (indexer + TEE prover, `.../v1/spr/*`).
   * Prover payloads are HPKE-encrypted to the attested enclave, so the proxy only relays ciphertext and adds the
   * API key server-side. Not served by apps/api yet; override with NEXT_PUBLIC_SPR_PROXY_URL.
   */
  spr: "/api/privacy/spr",
  /** GET {burner} · POST {burner, signature} (private Sealed wallet link; 409 burner_taken). */
  link: "/api/privacy/link",
} as const;

export type PrivacyStatus = PrivacyStatusResponse;
export type PrivacyDepositInfo = PrivateDepositInfo;
export type PrivacyDepositRecord = PrivateDepositRecord;

export const PRIVATE_ASSETS = ["SOL", "USDC"] as const satisfies readonly PrivacyAsset[];
export type PrivateAsset = PrivacyAsset;
export const isPrivateAsset = (a: string): a is PrivateAsset => (PRIVATE_ASSETS as readonly string[]).includes(a);
