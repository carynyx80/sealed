import type { MetadataRoute } from "next";
import { SITE_URL, STATIC_ROUTES } from "@/lib/site";

const DOC_SLUGS = [
  "how-it-works",
  "sealed-auction",
  "buyback-vault",
  "flywheel",
  "privacy",
  "custody",
  "architecture",
  "program",
  "api",
  "stack",
  "deploy",
  "security",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const pages: MetadataRoute.Sitemap = STATIC_ROUTES.map((path) => ({
    url: `${SITE_URL}${path === "/" ? "" : path}`,
    lastModified: now,
    changeFrequency: path === "/" || path === "/launch" ? "daily" : "weekly",
    priority: path === "/" ? 1 : path === "/docs" ? 0.8 : 0.7,
  }));
  const docs: MetadataRoute.Sitemap = DOC_SLUGS.map((slug) => ({
    url: `${SITE_URL}/docs/${slug}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.6,
  }));
  return [...pages, ...docs];
}
