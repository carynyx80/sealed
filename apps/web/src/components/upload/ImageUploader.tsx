"use client";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import clsx from "clsx";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { IS_MAINNET } from "@/lib/config";
import { clearSession, getSession, refreshCustodyInfo, useCustodySession } from "@/lib/custody";
import {
  ACCEPT_ATTR,
  blobToDataUri,
  centeredCrop,
  checkFile,
  decodeImage,
  exportCrop,
  fmtBytes,
  isUploadedImageUrl,
  OUTPUT_PX,
  UploadError,
  uploadTokenImage,
  type Crop,
  type DecodedImage,
} from "@/lib/upload/tokenImage";
import { TokenAvatar } from "../ui/TokenAvatar";
import { CropBox, CropPreview } from "./CropBox";

export interface ImageMeta {
  /** Wallet that uploaded it (the API ties uploads to the creator wallet). */
  wallet: string | null;
  /** True when kept inline as a data: URI (test networks only, upload service missing). */
  inline: boolean;
  bytes: number;
  mime: string;
  width: number;
  height: number;
}

type Phase =
  | { k: "idle" }
  | { k: "processing" }
  | { k: "crop"; img: DecodedImage }
  | { k: "auth"; img: DecodedImage; blob: Blob }
  | { k: "uploading"; img: DecodedImage; blob: Blob; progress: number }
  | { k: "error"; msg: string; img?: DecodedImage; blob?: Blob };

const ICON = "h-5 w-5 shrink-0";

function UploadGlyph() {
  return (
    <svg viewBox="0 0 24 24" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden>
      <circle cx="12" cy="12" r="10.5" strokeDasharray="2 3" />
      <path d="M12 16V8M8.5 11.5 12 8l3.5 3.5" />
    </svg>
  );
}

/**
 * Launch Studio token image: pick (click / Enter / Space), drag and drop, or paste; crop square in a circular
 * mask; sign in if needed (keeping the image); upload with progress and cancel. Emits the stored URL.
 */
export function ImageUploader({
  value,
  meta,
  ticker,
  onChange,
}: {
  value: string;
  meta: ImageMeta | null;
  ticker: string;
  onChange: (url: string, meta: ImageMeta | null) => void;
}) {
  const s = useCustodySession();
  const { setVisible, visible } = useWalletModal();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [crop, setCrop] = useState<Crop>(centeredCrop());
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string>("");
  const dragDepth = useRef(0);
  const abortRef = useRef<(() => void) | null>(null);
  const signAttempted = useRef(false);
  const imgRef = useRef<DecodedImage | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Release the object URL of whichever image we hold when it changes or on unmount.
  const holdImage = (img: DecodedImage | null) => {
    if (imgRef.current && imgRef.current !== img) imgRef.current.release();
    imgRef.current = img;
  };
  useEffect(() => () => {
    abortRef.current?.();
    imgRef.current?.release();
  }, []);

  const openPicker = () => inputRef.current?.click();

  const takeFile = useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    const bad = checkFile(file);
    if (bad) {
      setPhase({ k: "error", msg: bad });
      return;
    }
    setNote("");
    setPhase({ k: "processing" });
    try {
      const img = await decodeImage(file);
      holdImage(img);
      setCrop(centeredCrop());
      setPhase({ k: "crop", img });
    } catch (e) {
      holdImage(null);
      setPhase({ k: "error", msg: (e as Error).message });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------------------------------------------------------- upload, gated on a session */

  const finishInline = async (img: DecodedImage, blob: Blob) => {
    const uri = await blobToDataUri(blob);
    onChange(uri, { wallet: null, inline: true, bytes: blob.size, mime: blob.type, width: OUTPUT_PX, height: OUTPUT_PX });
    holdImage(null);
    setNote("The upload service isn't available here, so the image is kept with this launch instead.");
    setPhase({ k: "idle" });
    void img;
  };

  const doUpload = (img: DecodedImage, blob: Blob, token: string, wallet: string) => {
    setPhase({ k: "uploading", img, blob, progress: 0 });
    const h = uploadTokenImage(blob, token, (p) =>
      setPhase((cur) => (cur.k === "uploading" ? { ...cur, progress: p } : cur)),
    );
    abortRef.current = h.abort;
    h.promise
      .then((r) => {
        onChange(r.url, { wallet, inline: false, bytes: r.bytes, mime: r.mime, width: r.width, height: r.height });
        holdImage(null);
        setNote("");
        setPhase({ k: "idle" });
      })
      .catch(async (e: unknown) => {
        const err = e instanceof UploadError ? e : new UploadError((e as Error)?.message ?? "Upload failed.", "server");
        if (err.kind === "aborted") {
          setNote("Upload cancelled. Your crop is kept.");
          setPhase({ k: "crop", img });
          return;
        }
        if (err.kind === "unavailable" && !IS_MAINNET) return finishInline(img, blob);
        if (err.kind === "auth") clearSession(wallet);
        setPhase({ k: "error", msg: err.message, img, blob });
      })
      .finally(() => {
        abortRef.current = null;
      });
  };

  const startUpload = async (img: DecodedImage, blob: Blob) => {
    setNote("");
    const info = await refreshCustodyInfo();
    if (info.availability !== "available") {
      if (!IS_MAINNET) return finishInline(img, blob);
      setPhase({ k: "error", msg: "Sign-in is offline right now, so uploads are paused. You can continue without an image; initials are shown instead.", img, blob });
      return;
    }
    const session = s.wallet ? getSession(s.wallet) : null;
    if (s.wallet && session) return doUpload(img, blob, session.token, s.wallet);
    signAttempted.current = false;
    setPhase({ k: "auth", img, blob });
    if (!s.wallet) setVisible(true);
  };

  const confirmCrop = async (img: DecodedImage) => {
    setPhase({ k: "processing" });
    try {
      const blob = await exportCrop(img, crop);
      await startUpload(img, blob);
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message, img });
    }
  };

  // While waiting on auth: once a wallet is connected, ask it to sign (once); once signed in, upload.
  useEffect(() => {
    if (phase.k !== "auth") return;
    if (s.wallet && s.session) {
      doUpload(phase.img, phase.blob, s.session.token, s.wallet);
      return;
    }
    if (s.wallet && !s.session && !s.signingIn && !signAttempted.current && s.canSign) {
      signAttempted.current = true;
      void s.signIn().catch(() => undefined);
    }
  }, [phase, s.wallet, s.session, s.signingIn, s.canSign]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = () => {
    abortRef.current?.();
    if (phaseRef.current.k !== "uploading") {
      holdImage(null);
      setPhase({ k: "idle" });
    }
  };

  const retry = () => {
    if (phase.k !== "error") return;
    if (phase.img && phase.blob) void startUpload(phase.img, phase.blob);
    else if (phase.img) setPhase({ k: "crop", img: phase.img });
    else openPicker();
  };

  /* ------------------------------------------------------------------- paste + drag and drop */

  const accepting = phase.k === "idle" || phase.k === "error" || phase.k === "crop";
  useEffect(() => {
    if (!accepting) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const fileItem = items.find((i) => i.kind === "file");
      if (!fileItem) return; // plain text paste: leave it to the focused field
      const file = fileItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      void takeFile(file);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [accepting, takeFile]);

  const onDragEnter = (e: DragEvent) => {
    if (!accepting || !Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!accepting || !Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!accepting) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void takeFile(e.dataTransfer.files?.[0]);
  };

  /* -------------------------------------------------------------------------------- status text */

  const status =
    phase.k === "processing"
      ? "Preparing image…"
      : phase.k === "crop"
        ? note || `Image loaded, ${phase.img.width} by ${phase.img.height} pixels. Adjust the crop, then upload.`
        : phase.k === "auth"
          ? s.signingIn
            ? "Waiting for your wallet to sign in…"
            : s.wallet
              ? "Sign in with your wallet to upload. Your image is kept."
              : "Connect a wallet to upload. Your image is kept."
          : phase.k === "uploading"
            ? phase.progress >= 1
              ? "Upload sent, processing…"
              : `Uploading, ${Math.round(phase.progress * 100)} percent`
            : phase.k === "error"
              ? phase.msg
              : value
                ? note || "Token image ready."
                : note;

  const hasImage = phase.k === "idle" && !!value;

  return (
    <div
      className="mt-3"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          void takeFile(f);
        }}
      />
      <p className="sr-only" aria-live="polite" role="status">{status}</p>

      {/* empty / error / processing: the drop zone */}
      {(phase.k === "idle" && !value) || phase.k === "processing" || (phase.k === "error" && !phase.img) ? (
        <button
          type="button"
          onClick={openPicker}
          disabled={phase.k === "processing"}
          aria-describedby="img-drop-fine"
          className={clsx(
            "group flex min-h-[128px] w-full items-center gap-4 rounded-field border border-dashed px-4 py-5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-signal/50 focus-visible:ring-offset-2 focus-visible:ring-offset-sheet sm:px-5",
            dragging ? "border-ink bg-signal-tint/50" : phase.k === "error" ? "border-burn/60 bg-burn-tint/30" : "border-rule-strong bg-paper/40 hover:border-ink-muted hover:bg-paper/70",
          )}
        >
          <span className={clsx("flex h-14 w-14 shrink-0 items-center justify-center rounded-full border", dragging ? "border-ink text-ink" : "border-rule text-ink-slate")}>
            {phase.k === "processing" ? <span className="h-4 w-4 animate-spin rounded-full border border-ink-muted border-t-transparent" aria-hidden /> : <UploadGlyph />}
          </span>
          <span className="min-w-0">
            <span className="block text-[14px] font-medium text-ink">
              {phase.k === "processing" ? "Preparing image…" : dragging ? "Drop to use this image" : "Choose an image"}
              <span className="hidden font-normal text-ink-slate sm:inline">{phase.k === "processing" || dragging ? "" : ", drop one here, or paste"}</span>
            </span>
            <span id="img-drop-fine" className="num mt-1 block text-[11px] text-ink-muted">PNG, JPG, WebP or GIF · up to 5 MB · at least 64 × 64</span>
            {phase.k === "error" && <span role="alert" className="mt-2 block text-[12px] text-burn">{phase.msg}</span>}
          </span>
        </button>
      ) : null}
      {phase.k === "error" && !phase.img && value && (
        <button type="button" className="mt-2 min-h-[44px] text-sm text-ink-slate underline decoration-rule-strong underline-offset-4 hover:text-ink" onClick={() => setPhase({ k: "idle" })}>
          Keep the current image
        </button>
      )}

      {/* crop */}
      {phase.k === "crop" && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-[minmax(0,280px)_minmax(0,1fr)] sm:gap-6">
          <CropBox img={phase.img} crop={crop} onChange={setCrop} label={`Crop for ${phase.img.name}`} />
          <div className="min-w-0">
            <p className="eyebrow">Preview</p>
            <div className="mt-3 flex items-end gap-3">
              <CropPreview img={phase.img} crop={crop} size={64} />
              <CropPreview img={phase.img} crop={crop} size={40} />
              <CropPreview img={phase.img} crop={crop} size={24} />
            </div>
            <p className="num mt-3 truncate text-[11px] text-ink-muted">{phase.img.name} · {phase.img.width} × {phase.img.height} · {fmtBytes(phase.img.bytes)}</p>
            <p className="fine mt-1">Saved as a {OUTPUT_PX} × {OUTPUT_PX} square. Lobby cards, the token room and ledgers show it in a circle.</p>
            {note && <p className="mt-2 text-[12px] text-ink-slate">{note}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="btn-primary min-h-[44px]" onClick={() => void confirmCrop(phase.img)}>
                Upload image
              </button>
              <button type="button" className="btn-ghost min-h-[44px]" onClick={openPicker}>Choose another</button>
              <button type="button" className="min-h-[44px] px-3 text-sm text-ink-slate underline decoration-rule-strong underline-offset-4 hover:text-ink" onClick={cancel}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* sign-in gate / uploading / error with a prepared image */}
      {(phase.k === "auth" || phase.k === "uploading" || (phase.k === "error" && phase.img)) && (
        <div className="flex flex-col gap-4 rounded-field border border-rule bg-paper/40 p-4 sm:flex-row sm:items-center sm:p-5">
          <CropPreview img={(phase as { img: DecodedImage }).img} crop={crop} size={64} />
          <div className="min-w-0 flex-1">
            {phase.k === "auth" && (
              <>
                <p className="text-[14px] font-medium text-ink">{s.wallet ? "Sign in to upload" : "Connect a wallet to upload"}</p>
                <p className="mt-1 text-[12px] leading-relaxed text-ink-slate">
                  Uploads are tied to the creator wallet. Signing is a one-line message, not a transaction, and costs nothing. Your crop is kept.
                </p>
                {s.error && <p role="alert" className="mt-2 text-[12px] text-burn">{s.error}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {!s.wallet ? (
                    <button type="button" className="btn-primary min-h-[44px]" onClick={() => setVisible(true)} disabled={visible}>
                      {visible ? "Choose a wallet…" : "Connect wallet"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-primary min-h-[44px]"
                      disabled={s.signingIn || !s.canSign}
                      onClick={() => {
                        signAttempted.current = true;
                        void s.signIn().catch(() => undefined);
                      }}
                    >
                      {s.signingIn ? "Check your wallet…" : !s.canSign ? "Wallet can't sign messages" : "Sign in and upload"}
                    </button>
                  )}
                  <button type="button" className="btn-ghost min-h-[44px]" onClick={() => setPhase({ k: "crop", img: phase.img })}>Back to crop</button>
                </div>
              </>
            )}
            {phase.k === "uploading" && (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[14px] font-medium text-ink">{phase.progress >= 1 ? "Processing…" : "Uploading…"}</p>
                  <p className="num text-[12px] text-ink">{Math.round(phase.progress * 100)}%</p>
                </div>
                <div
                  role="progressbar"
                  aria-label="Upload progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(phase.progress * 100)}
                  className="mt-2 h-[3px] w-full overflow-hidden bg-rule"
                >
                  <div className="h-full bg-ink transition-[width] duration-150" style={{ width: `${Math.round(phase.progress * 100)}%` }} />
                </div>
                <p className="num mt-2 text-[11px] text-ink-muted">{fmtBytes(phase.blob.size)} · {phase.blob.type === "image/png" ? "PNG" : "WebP"}</p>
                <button type="button" className="btn-ghost mt-3 min-h-[44px]" onClick={cancel}>Cancel upload</button>
              </>
            )}
            {phase.k === "error" && (
              <>
                <p className="text-[14px] font-medium text-ink">Upload didn&apos;t finish</p>
                <p role="alert" className="mt-1 text-[12px] leading-relaxed text-burn">{phase.msg}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className="btn-primary min-h-[44px]" onClick={retry}>Try again</button>
                  <button type="button" className="btn-ghost min-h-[44px]" onClick={openPicker}>Choose another</button>
                  <button type="button" className="min-h-[44px] px-3 text-sm text-ink-slate underline decoration-rule-strong underline-offset-4 hover:text-ink" onClick={cancel}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* done */}
      {hasImage && (
        <div className="flex flex-col gap-4 rounded-field border border-rule bg-paper/40 p-4 sm:flex-row sm:items-center sm:p-5">
          <TokenAvatar src={value} ticker={ticker || "··"} size={64} eager />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gain" /> Token image ready
            </p>
            <p className="num mt-1 truncate text-[11px] text-ink-muted">
              {meta
                ? `${meta.width} × ${meta.height} · ${meta.mime.replace("image/", "").toUpperCase()} · ${fmtBytes(meta.bytes)}${meta.inline ? " · kept inline" : " · uploaded"}`
                : isUploadedImageUrl(value)
                  ? "Uploaded"
                  : value.startsWith("data:")
                    ? "Inline image"
                    : value}
            </p>
            {note && <p className="mt-1 text-[12px] leading-relaxed text-ink-slate">{note}</p>}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost min-h-[44px]" onClick={openPicker}>Replace</button>
            <button
              type="button"
              className="btn-ghost min-h-[44px]"
              onClick={() => {
                onChange("", null);
                setNote("Image removed. Initials will be shown instead.");
              }}
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {phase.k === "idle" && !value && note && <p className="mt-2 text-[12px] text-ink-slate" aria-hidden>{note}</p>}
    </div>
  );
}
