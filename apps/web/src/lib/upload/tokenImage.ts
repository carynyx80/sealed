"use client";
// Token image pipeline for Launch Studio: client-side checks, decode, square crop on a canvas, and an
// XMLHttpRequest upload (for progress + abort) to POST /api/uploads/token-image.
//
// Backend contract:
//   POST ${API_URL}/api/uploads/token-image   Authorization: Bearer <session token>, multipart field "file"
//     PNG/JPG/WEBP/GIF ≤ 5 MB (server re-encodes to 512×512 WebP)
//     201 → { id, url, width, height, bytes, mime }   400/413/429 → { error }   401 → session invalid
//   GET  ${API_URL}/api/images/<id>.webp            immutable image
import { API_URL } from "../config";

export const UPLOAD_ROUTE = "/api/uploads/token-image";
export const IMAGE_ROUTE_PREFIX = "/api/images/";
export const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const ACCEPT_ATTR = ACCEPTED_TYPES.join(",");
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MIN_IMAGE_PX = 64;
/** Square edge of the exported crop (the server re-encodes to the same size). */
export const OUTPUT_PX = 512;

export interface UploadedImage {
  id: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  mime: string;
}

export type UploadErrorKind = "network" | "unavailable" | "auth" | "too_large" | "rate_limited" | "rejected" | "server" | "aborted";

export class UploadError extends Error {
  constructor(message: string, public readonly kind: UploadErrorKind, public readonly status = 0) {
    super(message);
    this.name = "UploadError";
  }
}

/* --------------------------------------------------------------------------------------- checks */

const EXT_TYPE: Record<string, (typeof ACCEPTED_TYPES)[number]> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** The file's image type, falling back to its extension when the browser gives no MIME type. */
function fileType(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return (ext && EXT_TYPE[ext]) || "";
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Cheap checks before decoding. Returns a friendly message, or null when the file can be tried. */
export function checkFile(file: File): string | null {
  const t = fileType(file);
  if (!(ACCEPTED_TYPES as readonly string[]).includes(t)) {
    if (t === "image/svg+xml") return "SVG isn't supported. Export it as a PNG or WebP first.";
    if (t === "image/heic" || t === "image/heif") return "HEIC photos aren't supported. Export as JPG or PNG first.";
    return "That file isn't a PNG, JPG, WebP or GIF image.";
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return `That image is ${fmtBytes(file.size)}. The limit is 5 MB.`;
  return null;
}

export interface DecodedImage {
  /** Object URL for previews; revoke with `release()`. */
  url: string;
  img: HTMLImageElement;
  width: number;
  height: number;
  name: string;
  bytes: number;
  release: () => void;
}

/** Decode the file in the browser (proves it's a real image) and enforce the minimum size. */
export async function decodeImage(file: File): Promise<DecodedImage> {
  const url = URL.createObjectURL(file);
  const release = () => URL.revokeObjectURL(url);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error("That image couldn't be read. It may be corrupt or in an unsupported format.");
    }
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) throw new Error("That image couldn't be read. It may be corrupt or in an unsupported format.");
    if (width < MIN_IMAGE_PX || height < MIN_IMAGE_PX) {
      throw new Error(`That image is ${width} × ${height} px. Use one at least ${MIN_IMAGE_PX} × ${MIN_IMAGE_PX} px (512 × 512 or larger looks best).`);
    }
    return { url, img, width, height, name: file.name || "pasted image", bytes: file.size, release };
  } catch (e) {
    release();
    throw e;
  }
}

/* ----------------------------------------------------------------------------------------- crop */

/** Square crop: `zoom` ≥ 1 (1 = largest square that fits), centre (u, v) as fractions of the source image. */
export interface Crop {
  zoom: number;
  u: number;
  v: number;
}
export const MAX_ZOOM = 4;
export const centeredCrop = (): Crop => ({ zoom: 1, u: 0.5, v: 0.5 });

/** Side of the crop square in source pixels. */
export const cropSide = (w: number, h: number, zoom: number) => Math.min(w, h) / Math.max(1, zoom);

/** Clamp zoom to [1, MAX_ZOOM] and the centre so the crop square never leaves the image. */
export function clampCrop(c: Crop, w: number, h: number): Crop {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, Number.isFinite(c.zoom) ? c.zoom : 1));
  const side = cropSide(w, h, zoom);
  const hu = side / 2 / w;
  const hv = side / 2 / h;
  const clamp = (x: number, lo: number, hi: number) => (lo >= hi ? 0.5 : Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : 0.5)));
  return { zoom, u: clamp(c.u, hu, 1 - hu), v: clamp(c.v, hv, 1 - hv) };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/** Render the crop to an OUTPUT_PX square and encode it (WebP where supported, else PNG), always ≤ 5 MB. */
export async function exportCrop(d: DecodedImage, crop: Crop): Promise<Blob> {
  const c = clampCrop(crop, d.width, d.height);
  const side = cropSide(d.width, d.height, c.zoom);
  const sx = c.u * d.width - side / 2;
  const sy = c.v * d.height - side / 2;
  const out = Math.min(OUTPUT_PX, Math.max(MIN_IMAGE_PX, Math.round(side)));
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't prepare images. Try another browser.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(d.img, sx, sy, side, side, 0, 0, out, out);
  let blob = await canvasToBlob(canvas, "image/webp", 0.92);
  // Safari < 17 ignores the WebP request and hands back PNG; anything else unexpected falls back to PNG.
  if (!blob || (blob.type !== "image/webp" && blob.type !== "image/png")) blob = await canvasToBlob(canvas, "image/png");
  if (blob && blob.size > MAX_UPLOAD_BYTES) blob = await canvasToBlob(canvas, "image/webp", 0.8);
  if (!blob || blob.size === 0 || blob.size > MAX_UPLOAD_BYTES) throw new Error("The cropped image couldn't be prepared. Try a different image.");
  return blob;
}

/** Inline data: URI of a blob (used only off mainnet, when the upload service isn't there). */
export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("The image couldn't be read."));
    r.readAsDataURL(blob);
  });
}

/* ---------------------------------------------------------------------------------------- upload */

/** Absolute URL for an uploaded image (the API may answer with a path). */
export function resolveImageUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("/")) return `${API_URL}${url}`;
  return url;
}

/** True for URLs that point at this API's image store. */
export function isUploadedImageUrl(url: string): boolean {
  return !!url && resolveImageUrl(url).startsWith(`${API_URL}${IMAGE_ROUTE_PREFIX}`);
}

function serverMessage(xhr: XMLHttpRequest): string | null {
  try {
    const j = JSON.parse(xhr.responseText) as { error?: unknown; message?: unknown };
    const m = typeof j?.error === "string" ? j.error : typeof j?.message === "string" ? j.message : null;
    return m && m.length < 240 ? m : null;
  } catch {
    return null;
  }
}

export interface UploadHandle {
  promise: Promise<UploadedImage>;
  abort: () => void;
}

/** Upload with progress. `onProgress` receives 0..1 (upload bytes sent). */
export function uploadTokenImage(blob: Blob, token: string, onProgress?: (p: number) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadedImage>((resolve, reject) => {
    const ext = blob.type === "image/png" ? "png" : "webp";
    const form = new FormData();
    form.append("file", blob, `token-image.${ext}`);
    xhr.open("POST", `${API_URL}${UPLOAD_ROUTE}`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.timeout = 60_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      const s = xhr.status;
      const msg = serverMessage(xhr);
      if (s === 200 || s === 201) {
        try {
          const j = JSON.parse(xhr.responseText) as Partial<UploadedImage>;
          if (!j || typeof j.url !== "string" || !j.url) throw new Error("no url");
          resolve({
            id: String(j.id ?? ""),
            url: resolveImageUrl(j.url),
            width: Number(j.width) || OUTPUT_PX,
            height: Number(j.height) || OUTPUT_PX,
            bytes: Number(j.bytes) || blob.size,
            mime: String(j.mime ?? "image/webp"),
          });
        } catch {
          reject(new UploadError("The server's reply was unreadable. Try again.", "server", s));
        }
        return;
      }
      if (s === 401 || s === 403) return reject(new UploadError("Your sign-in has expired. Sign in again to upload.", "auth", s));
      if (s === 404 || s === 405 || s === 501) return reject(new UploadError("Image uploads aren't available on this server yet.", "unavailable", s));
      if (s === 413) return reject(new UploadError(msg ?? "That image is too large. The limit is 5 MB.", "too_large", s));
      if (s === 429) return reject(new UploadError(msg ?? "Too many uploads in a short time. Wait a minute and try again.", "rate_limited", s));
      if (s >= 400 && s < 500) return reject(new UploadError(msg ?? "The server couldn't accept that image. Try a different one.", "rejected", s));
      reject(new UploadError("The upload service had a problem. Try again in a moment.", "server", s));
    };
    xhr.onerror = () => reject(new UploadError("Couldn't reach the Sealed service. Check your connection and try again.", "network"));
    xhr.ontimeout = () => reject(new UploadError("The upload timed out. Try again.", "network"));
    xhr.onabort = () => reject(new UploadError("Upload cancelled.", "aborted"));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

/* ------------------------------------------------------------------------------------ rendering */

/** Whether a launch's imageUri is safe and worth handing to an <img>. Anything else shows initials. */
export function isRenderableImageSrc(src: string | null | undefined): src is string {
  if (!src || typeof src !== "string") return false;
  const s = src.trim();
  if (s.startsWith("data:")) return /^data:image\/(png|jpe?g|webp|gif|svg\+xml|avif)[;,]/i.test(s);
  if (s.startsWith("blob:")) return true;
  if (s.startsWith("/")) return !s.startsWith("//");
  return /^https?:\/\/[^\s]+$/i.test(s);
}
