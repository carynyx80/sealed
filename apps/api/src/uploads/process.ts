import { createHash } from "node:crypto";
import type { Sharp, SharpOptions } from "sharp";
import { TOKEN_IMAGE_MIN_DIMENSION, TOKEN_IMAGE_SIZE } from "@sealed/shared";

export type DetectedImageType = "png" | "jpeg" | "webp" | "gif";

/** Identify the image format from its leading bytes. SVG / anything else → null. */
export function sniffImageType(b: Buffer): DetectedImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6) {
    const sig = b.subarray(0, 6).toString("latin1");
    if (sig === "GIF87a" || sig === "GIF89a") return "gif";
  }
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export class ImageProcessError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

type SharpFn = (input: Buffer, options?: SharpOptions) => Sharp;
let sharpLoader: Promise<SharpFn> | null = null;
/** Lazy-load sharp so a broken native install degrades only the uploader (503), never the whole API. */
export function loadSharp(): Promise<SharpFn> {
  sharpLoader ??= import("sharp")
    .then((m) => (m.default ?? m) as unknown as SharpFn)
    .catch((err) => {
      sharpLoader = null;
      throw err;
    });
  return sharpLoader;
}

export interface ProcessedImage {
  bytes: Buffer;
  width: number;
  height: number;
  sha256: string;
  sourceType: DetectedImageType;
}

/** Max decoded input pixels (decompression-bomb guard; ~8k×6k). */
const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Verify + normalise an uploaded image: first frame only, auto-oriented, all metadata stripped,
 * center-cropped to a square and resized to 512×512 WebP.
 */
export async function processTokenImage(input: Buffer): Promise<ProcessedImage> {
  const sourceType = sniffImageType(input);
  if (!sourceType) throw new ImageProcessError(400, "Unsupported image type. Use PNG, JPG, WEBP or GIF.");
  let sharp: SharpFn;
  try {
    sharp = await loadSharp();
  } catch {
    throw new ImageProcessError(503, "Image processing unavailable");
  }
  const opts: SharpOptions = { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS, pages: 1, page: 0, sequentialRead: true };
  let meta;
  try {
    meta = await sharp(input, opts).metadata();
  } catch {
    throw new ImageProcessError(400, "Could not decode image");
  }
  const decodedFormat: string = meta.format;
  if (decodedFormat !== sourceType) throw new ImageProcessError(400, "Unsupported image type. Use PNG, JPG, WEBP or GIF.");
  const w = meta.width ?? 0;
  const h = meta.pageHeight ?? meta.height ?? 0;
  if (!w || !h) throw new ImageProcessError(400, "Could not decode image");
  if (w < TOKEN_IMAGE_MIN_DIMENSION || h < TOKEN_IMAGE_MIN_DIMENSION) {
    throw new ImageProcessError(400, `Image too small (min ${TOKEN_IMAGE_MIN_DIMENSION}×${TOKEN_IMAGE_MIN_DIMENSION})`);
  }
  let out: { data: Buffer; info: { width: number; height: number } };
  try {
    // Output never carries metadata (EXIF/XMP/ICC) unless keepMetadata()/withMetadata() is called.
    out = await sharp(input, opts)
      .rotate() // auto-orient from EXIF, then the orientation tag is dropped
      .resize(TOKEN_IMAGE_SIZE, TOKEN_IMAGE_SIZE, { fit: "cover", position: "centre" })
      .webp({ quality: 86, effort: 4 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new ImageProcessError(400, "Could not decode image");
  }
  if (out.info.width !== TOKEN_IMAGE_SIZE || out.info.height !== TOKEN_IMAGE_SIZE) throw new ImageProcessError(400, "Could not decode image");
  return { bytes: out.data, width: out.info.width, height: out.info.height, sha256: createHash("sha256").update(out.data).digest("hex"), sourceType };
}
