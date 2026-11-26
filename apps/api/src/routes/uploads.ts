import { randomBytes } from "node:crypto";
import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { TOKEN_IMAGE_MAX_BYTES, TOKEN_IMAGE_PATH_RE, UPLOAD_ROUTES, type TokenImageUploadResponse } from "@sealed/shared";
import { sendError, type AppContext } from "../context.js";
import { RateLimiter } from "../offchain/auth/rateLimit.js";
import { requireAuth } from "../offchain/auth/requireAuth.js";
import type { ImageStore } from "../uploads/imageStore.js";
import { ImageProcessError, processTokenImage } from "../uploads/process.js";

const TOO_LARGE = "Image too large (max 5 MB)";
export const FOREIGN_IMAGE_ERROR = "Upload the token image with Sealed's uploader";

/** Public origin of this API: PUBLIC_API_URL, else derived from the request (trustProxy → x-forwarded-proto/host). */
export function requestOrigin(req: FastifyRequest): string {
  const raw = `${req.protocol}://${req.host}`;
  try {
    return new URL(raw).origin; // normalises case + default ports (":443", ":80")
  } catch {
    return raw;
  }
}
export function publicOrigin(ctx: AppContext, req: FastifyRequest): string {
  return ctx.cfg.publicApiUrl ?? requestOrigin(req);
}

function imagesOf(ctx: AppContext): ImageStore {
  if (!ctx.images) throw new Error("image store not configured");
  return ctx.images;
}

/**
 * Validate a launch `imageUri`. Empty → ok (initials fallback). A URL that points at this API's
 * /api/images/<id> must exist (and belong to `wallet` when known). Elsewhere: https only, and on mainnet
 * foreign hosts are rejected. Returns an error message, or null when acceptable.
 */
export async function validateTokenImageUri(ctx: AppContext, req: FastifyRequest, uri: string, wallet?: string): Promise<string | null> {
  const raw = uri.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "imageUri must be an https URL";
  }
  const mainnet = ctx.cfg.network === "mainnet";
  const origins = new Set<string>([requestOrigin(req).toLowerCase()]);
  if (ctx.cfg.publicApiUrl) origins.add(new URL(ctx.cfg.publicApiUrl).origin.toLowerCase());
  const m = TOKEN_IMAGE_PATH_RE.exec(u.pathname);
  const own = origins.has(u.origin.toLowerCase()) && !!m && !u.search && !u.hash && !u.username && !u.password;
  if (!own) {
    if (mainnet) return FOREIGN_IMAGE_ERROR;
    if (u.protocol !== "https:") return "imageUri must be an https URL";
    return null;
  }
  if (mainnet && u.protocol !== "https:") return FOREIGN_IMAGE_ERROR;
  const img = ctx.images ? await ctx.images.get(m![1]!) : null;
  if (!img) return "Token image not found — upload it again";
  if (wallet && img.owner !== wallet) return "Token image was uploaded by a different wallet — upload it again";
  return null;
}

export async function uploadRoutes(app: FastifyInstance, ctx: AppContext) {
  const perHour = new RateLimiter(ctx.cfg.uploadRateLimitPerHour ?? 20, 3_600_000);

  // Encapsulated so the multipart parser only exists for the upload route.
  await app.register(async (scope) => {
    await scope.register(multipart, {
      throwFileSizeLimit: true,
      limits: { fileSize: TOKEN_IMAGE_MAX_BYTES, files: 1, fields: 4, fieldSize: 1024, parts: 5, headerPairs: 64 },
    });

    scope.post(UPLOAD_ROUTES.tokenImage, async (req, reply) => {
      const wallet = await requireAuth(req, reply);
      if (!wallet || reply.sent) return reply;
      if (!req.isMultipart()) return sendError(reply, 400, 'Expected multipart/form-data with a "file" field');
      if (!perHour.hit(`img:${wallet}`)) return sendError(reply, 429, "Too many uploads — try again later");

      let buf: Buffer;
      try {
        const part = await req.file();
        if (!part || part.fieldname !== "file") return sendError(reply, 400, 'Missing "file" field');
        buf = await part.toBuffer();
        if (part.file.truncated) return sendError(reply, 413, TOO_LARGE);
      } catch (err) {
        const e = err as { code?: string; statusCode?: number };
        if (e.code === "FST_REQ_FILE_TOO_LARGE" || e.statusCode === 413) return sendError(reply, 413, TOO_LARGE);
        req.log.warn({ err }, "upload: malformed multipart body");
        return sendError(reply, 400, "Malformed upload");
      }
      if (buf.length === 0) return sendError(reply, 400, "Empty file");
      if (buf.length > TOKEN_IMAGE_MAX_BYTES) return sendError(reply, 413, TOO_LARGE);

      let img;
      try {
        img = await processTokenImage(buf);
      } catch (err) {
        if (err instanceof ImageProcessError) return sendError(reply, err.statusCode, err.message);
        throw err;
      }
      const { rec, deduped } = await imagesOf(ctx).put({
        id: randomBytes(16).toString("hex"),
        owner: wallet,
        mime: "image/webp",
        bytes: img.bytes,
        width: img.width,
        height: img.height,
        sha256: img.sha256,
        createdAt: new Date(),
      });
      req.log.info({ wallet, id: rec.id, deduped, from: img.sourceType, inBytes: buf.length, outBytes: rec.bytes.length }, "token image uploaded");
      const res: TokenImageUploadResponse = {
        id: rec.id,
        url: `${publicOrigin(ctx, req)}${UPLOAD_ROUTES.image(rec.id)}`,
        width: 512,
        height: 512,
        bytes: rec.bytes.length,
        mime: "image/webp",
      };
      return reply.code(201).send(res);
    });
  });

  app.get<{ Params: { file: string } }>("/api/images/:file", async (req, reply) => {
    const m = /^([0-9a-f]{32})(?:\.webp)?$/.exec(req.params.file);
    const rec = m ? await imagesOf(ctx).get(m[1]!) : null;
    if (!rec) return sendError(reply, 404, "Not found");
    const etag = `"${rec.sha256}"`;
    reply
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("etag", etag)
      .header("cross-origin-resource-policy", "cross-origin")
      .header("x-content-type-options", "nosniff");
    const inm = req.headers["if-none-match"];
    if (typeof inm === "string" && inm.split(",").some((t) => { const v = t.trim().replace(/^W\//, ""); return v === etag || v === "*"; })) {
      return reply.code(304).send();
    }
    return reply.code(200).type(rec.mime).send(rec.bytes);
  });
}
