/**
 * Docs information architecture. One source of truth for the sidebar, the mobile sheet,
 * prev/next links and the overview index. Order here = reading order.
 */
export interface DocPage {
  href: string;
  /** Section number shown as "§ 02". */
  n: string;
  title: string;
  /** One line for the overview index and prev/next cards. */
  summary: string;
}

export interface DocGroup {
  label: string;
  pages: DocPage[];
}

export const DOC_GROUPS: DocGroup[] = [
  {
    label: "Product",
    pages: [
      { href: "/docs", n: "00", title: "Overview", summary: "What Sealed is, the four-phase loop, who it is for, and what is live today." },
      { href: "/docs/how-it-works", n: "01", title: "How it works", summary: "A launch end to end: supply split, timing windows, statuses and who calls what." },
      { href: "/docs/custody", n: "02", title: "Custody", summary: "Offchain custodial mode: sign-in, deposits, withdrawals, limits and proof of reserves." },
      { href: "/docs/sealed-auction", n: "03", title: "Sealed auction", summary: "Commit-reveal, the 80-byte keccak preimage, the tick grid and uniform clearing." },
      { href: "/docs/buyback-vault", n: "04", title: "Buyback vault", summary: "The 10–15% fee-credit line, why the vault cannot be withdrawn, and the drip schedule." },
      { href: "/docs/flywheel", n: "05", title: "Flywheel", summary: "Fee routing: 80/20 while repaying, 50/35/15 forever after, and the anti-snipe rule." },
      { href: "/docs/privacy", n: "06", title: "Privacy", summary: "Helius Privacy Rings: what is hidden, what stays public, and the phase A/B/C plan." },
    ],
  },
  {
    label: "Engineering",
    pages: [
      { href: "/docs/architecture", n: "07", title: "Architecture", summary: "Monorepo layout, data flow, and the indexer, relayer and keeper workers." },
      { href: "/docs/program", n: "08", title: "Onchain program", summary: "Roadmap non-custodial mode: Anchor instructions, accounts, seeds, events, errors." },
      { href: "/docs/api", n: "09", title: "API reference", summary: "Every REST and custody endpoint, the WebSocket protocol and /llms.txt." },
    ],
  },
  {
    label: "Operate",
    pages: [
      { href: "/docs/stack", n: "10", title: "What powers Sealed", summary: "Solana, Anchor, Helius, Jupiter, Next.js, Fastify and the rest, with status." },
      { href: "/docs/deploy", n: "11", title: "Deploy", summary: "Local quickstart, environment variables, Vercel, Railway and devnet." },
      { href: "/docs/security", n: "12", title: "Security", summary: "Custody disclosure, trust model, tested invariants, limitations, roadmap." },
    ],
  },
];

export const DOC_PAGES: DocPage[] = DOC_GROUPS.flatMap((g) => g.pages);

export function docByHref(href: string): DocPage | undefined {
  const clean = href.replace(/\/$/, "") || "/docs";
  return DOC_PAGES.find((p) => p.href === clean);
}

export function neighbours(href: string): { prev: DocPage | null; next: DocPage | null } {
  const clean = href.replace(/\/$/, "") || "/docs";
  const i = DOC_PAGES.findIndex((p) => p.href === clean);
  if (i < 0) return { prev: null, next: null };
  return { prev: DOC_PAGES[i - 1] ?? null, next: DOC_PAGES[i + 1] ?? null };
}
