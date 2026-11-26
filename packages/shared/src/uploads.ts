/**
 * Token image uploads (API contract).
 *
 * POST /api/uploads/token-image   (Authorization: Bearer <session>; multipart/form-data, single field "file")
 *   → 201 TokenImageUploadResponse
 *   → 400 unsupported type / undecodable / too small · 401 unauthorized · 413 too large · 429 rate limited
 * GET  /api/images/:id(.webp)?    → image/webp (public, immutable; ETag = sha256; If-None-Match → 304) · 404
 *
 * On mainnet, POST /api/launches only accepts an empty imageUri or one returned by the uploader for the
 * signed-in creator wallet.
 */
export const TOKEN_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const TOKEN_IMAGE_MIN_DIMENSION = 64;
export const TOKEN_IMAGE_SIZE = 512;
export const TOKEN_IMAGE_ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export const UPLOAD_ROUTES = {
  tokenImage: "/api/uploads/token-image",
  image: (id: string) => `/api/images/${id}.webp`,
} as const;

/** Path of an image served by this API: `/api/images/<32 hex>` with optional `.webp`. */
export const TOKEN_IMAGE_PATH_RE = /^\/api\/images\/([0-9a-f]{32})(?:\.webp)?$/;

export interface TokenImageUploadResponse {
  id: string;
  /** Absolute URL to use as the launch `imageUri`. */
  url: string;
  width: 512;
  height: 512;
  /** Encoded size in bytes. */
  bytes: number;
  mime: "image/webp";
}
