/**
 * Helius Privacy Ring operator smoke test (tiny amounts; mainnet needs --i-understand-mainnet).
 * Implementation lives in apps/api/scripts/privacy-smoke.ts so `@heliuslabs/spr` resolves from apps/api.
 *
 *   HELIUS_API_KEY=… node --import tsx scripts/privacy-smoke.ts --api https://<api> --keypair <operator.json> --network devnet
 */
import { pathToFileURL } from "node:url";
import path from "node:path";

// Loaded via a file URL so it runs as an ES module inside apps/api (type: module) whatever this entry's format is.
void import(pathToFileURL(path.resolve(__dirname, "../apps/api/scripts/privacy-smoke.ts")).href);
