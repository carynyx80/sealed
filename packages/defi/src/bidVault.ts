/**
 * Client-side sealed-bid vault.
 *
 * A sealed bid is only revealable by whoever holds its preimage (max_price, bid_amount, 32-byte salt). Losing the
 * salt means the bid can never be revealed (and is slashed 1% at claim); leaking it before the reveal window
 * leaks the bid. So salts are stored ENCRYPTED AT REST:
 *
 *   sig  = wallet.signMessage(utf8("sealed-launchpad:bid-vault:v1:<wallet>"))      // ed25519 ⇒ deterministic
 *   key  = HKDF-SHA256(ikm = sig, salt = utf8("sealed-launchpad/bid-vault/v1"), info = utf8(wallet)) → AES-256-GCM
 *   ct   = AES-GCM(key, iv = 12 random bytes, aad = utf8("<wallet>|<launchId>"), JSON(record))
 *
 * The CryptoKey is non-extractable and lives only in memory for the session. Only ciphertext reaches storage
 * (IndexedDB by default in browsers, localStorage fallback, memory in tests/SSR). Backups are the same encrypted
 * entries as JSON; restoring requires the same wallet (same signature ⇒ same key). AAD binds each entry to its
 * wallet and launch so entries cannot be swapped between launches.
 */

export const VAULT_SIGN_PREFIX = "sealed-launchpad:bid-vault:v1:";
const HKDF_SALT = "sealed-launchpad/bid-vault/v1";
const BACKUP_VERSION = 1 as const;

const te = new TextEncoder();
const td = new TextDecoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) unavailable — bid vault requires a secure context (https or localhost)");
  return s;
}

function b64e(u: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(u).toString("base64");
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
}
function b64d(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/* ------------------------------------------------------------------------------------------------ storage */

export interface VaultStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export function memoryStorage(init?: Record<string, string>): VaultStorage {
  const m = new Map<string, string>(Object.entries(init ?? {}));
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    keys: async () => [...m.keys()],
  };
}

export function localStorageStorage(prefix = "sealed-bid-vault:"): VaultStorage {
  const ls = () => {
    if (typeof localStorage === "undefined") throw new Error("localStorage unavailable");
    return localStorage;
  };
  return {
    get: async (k) => ls().getItem(prefix + k),
    set: async (k, v) => ls().setItem(prefix + k, v),
    delete: async (k) => ls().removeItem(prefix + k),
    keys: async () => {
      const s = ls();
      const out: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k?.startsWith(prefix)) out.push(k.slice(prefix.length));
      }
      return out;
    },
  };
}

export function indexedDbStorage(dbName = "sealed-launchpad", storeName = "bid-vault"): VaultStorage {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () =>
    (dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("indexedDB unavailable"));
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction(storeName, mode);
      const r = fn(tx.objectStore(storeName));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  };
  return {
    get: async (k) => ((await run("readonly", (s) => s.get(k))) as string | undefined) ?? null,
    set: async (k, v) => void (await run("readwrite", (s) => s.put(v, k))),
    delete: async (k) => void (await run("readwrite", (s) => s.delete(k))),
    keys: async () => (await run("readonly", (s) => s.getAllKeys())).map(String),
  };
}

/** Best available persistent storage: IndexedDB → localStorage → memory. */
export function defaultVaultStorage(): VaultStorage {
  if (typeof indexedDB !== "undefined") return indexedDbStorage();
  if (typeof localStorage !== "undefined") return localStorageStorage();
  return memoryStorage();
}

/* ------------------------------------------------------------------------------------------------ crypto */

export function vaultSignMessage(wallet: string): Uint8Array {
  return te.encode(VAULT_SIGN_PREFIX + wallet);
}

/** Derive the AES-GCM vault key from the wallet's signature over `vaultSignMessage(wallet)`. */
export async function deriveVaultKey(signature: Uint8Array, wallet: string): Promise<CryptoKey> {
  const ikm = await subtle().importKey("raw", signature as BufferSource, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: te.encode(HKDF_SALT), info: te.encode(wallet) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export class BidVaultDecryptError extends Error {
  constructor(message = "Unable to decrypt bid vault entry (wrong wallet/key or corrupted data)") {
    super(message);
    this.name = "BidVaultDecryptError";
  }
}

/* ------------------------------------------------------------------------------------------------ records */

export interface StoredBid {
  launchId: string;
  bidder: string;
  network: string;
  commitmentHex: string;
  /** u64 decimal strings (atoms). */
  maxPrice: string;
  bidAmount: string;
  deposit: string;
  saltHex: string;
  tick: number;
  createdTs: number;
  txSignature?: string;
  autoRevealQueued?: boolean;
  revealed?: boolean;
}

interface EncryptedEntry {
  v: 1;
  id: string; // launchId
  iv: string; // base64
  ct: string; // base64
}

export interface BidVaultBackup {
  kind: "sealed-launchpad-bid-vault";
  version: typeof BACKUP_VERSION;
  wallet: string;
  exportedTs: number;
  entries: EncryptedEntry[];
}

export interface UnlockArgs {
  wallet: string;
  signMessage: (msg: Uint8Array) => Promise<Uint8Array>;
  storage?: VaultStorage;
}

export class BidVault {
  private constructor(
    readonly wallet: string,
    private readonly key: CryptoKey,
    private readonly storage: VaultStorage,
  ) {}

  /** Prompts the wallet to sign the vault message once per session and derives the key. */
  static async unlock({ wallet, signMessage, storage }: UnlockArgs): Promise<BidVault> {
    const sig = await signMessage(vaultSignMessage(wallet));
    return new BidVault(wallet, await deriveVaultKey(sig, wallet), storage ?? defaultVaultStorage());
  }

  /** Construct from an already-derived key (tests, or a cached session key). */
  static fromKey(wallet: string, key: CryptoKey, storage: VaultStorage = memoryStorage()): BidVault {
    return new BidVault(wallet, key, storage);
  }

  private storageKey(launchId: string): string {
    return `${this.wallet}:${launchId}`;
  }

  private aad(launchId: string): Uint8Array {
    return te.encode(`${this.wallet}|${launchId}`);
  }

  private async encrypt(rec: StoredBid): Promise<EncryptedEntry> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: this.aad(rec.launchId) as BufferSource },
      this.key,
      te.encode(JSON.stringify(rec)) as BufferSource,
    );
    return { v: 1, id: rec.launchId, iv: b64e(iv), ct: b64e(new Uint8Array(ct)) };
  }

  private async decrypt(e: EncryptedEntry): Promise<StoredBid> {
    try {
      const pt = await subtle().decrypt(
        { name: "AES-GCM", iv: b64d(e.iv) as BufferSource, additionalData: this.aad(e.id) as BufferSource },
        this.key,
        b64d(e.ct) as BufferSource,
      );
      return JSON.parse(td.decode(pt)) as StoredBid;
    } catch {
      throw new BidVaultDecryptError();
    }
  }

  async save(rec: StoredBid): Promise<void> {
    if (rec.bidder !== this.wallet) throw new Error("bid belongs to a different wallet");
    await this.storage.set(this.storageKey(rec.launchId), JSON.stringify(await this.encrypt(rec)));
  }

  async update(launchId: string, patch: Partial<StoredBid>): Promise<StoredBid | null> {
    const cur = await this.get(launchId);
    if (!cur) return null;
    const next = { ...cur, ...patch, launchId: cur.launchId, bidder: cur.bidder };
    await this.save(next);
    return next;
  }

  async get(launchId: string): Promise<StoredBid | null> {
    const raw = await this.storage.get(this.storageKey(launchId));
    if (!raw) return null;
    return this.decrypt(JSON.parse(raw) as EncryptedEntry);
  }

  async remove(launchId: string): Promise<void> {
    await this.storage.delete(this.storageKey(launchId));
  }

  private async rawEntries(): Promise<EncryptedEntry[]> {
    const prefix = `${this.wallet}:`;
    const out: EncryptedEntry[] = [];
    for (const k of await this.storage.keys()) {
      if (!k.startsWith(prefix)) continue;
      const raw = await this.storage.get(k);
      if (raw) out.push(JSON.parse(raw) as EncryptedEntry);
    }
    return out;
  }

  /** All decryptable bids for this wallet (undecryptable entries are skipped). */
  async list(): Promise<StoredBid[]> {
    const out: StoredBid[] = [];
    for (const e of await this.rawEntries()) {
      try {
        out.push(await this.decrypt(e));
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => a.createdTs - b.createdTs);
  }

  /** Encrypted backup JSON (safe to download; useless without the wallet). */
  async exportBackup(): Promise<string> {
    const b: BidVaultBackup = {
      kind: "sealed-launchpad-bid-vault",
      version: BACKUP_VERSION,
      wallet: this.wallet,
      exportedTs: Math.floor(Date.now() / 1000),
      entries: await this.rawEntries(),
    };
    return JSON.stringify(b, null, 2);
  }

  /** Imports a backup; every entry is decrypted first to verify it belongs to this wallet. Returns count imported. */
  async importBackup(json: string | BidVaultBackup, opts: { overwrite?: boolean } = {}): Promise<number> {
    const b = (typeof json === "string" ? JSON.parse(json) : json) as BidVaultBackup;
    if (b?.kind !== "sealed-launchpad-bid-vault" || b.version !== BACKUP_VERSION || !Array.isArray(b.entries)) {
      throw new Error("not a sealed-launchpad bid vault backup");
    }
    if (b.wallet !== this.wallet) throw new BidVaultDecryptError(`backup belongs to wallet ${b.wallet}`);
    let n = 0;
    for (const e of b.entries) {
      await this.decrypt(e); // throws on wrong key / tamper
      const k = this.storageKey(e.id);
      if (!opts.overwrite && (await this.storage.get(k))) continue;
      await this.storage.set(k, JSON.stringify(e));
      n++;
    }
    return n;
  }
}
