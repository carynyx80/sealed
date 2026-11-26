import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.25, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const LockIcon = (p: P) => (<svg {...base} {...p}><rect x="4" y="11" width="16" height="10" rx="2.5" /><path d="M8 11V7a4 4 0 1 1 8 0v4" /></svg>);
export const EyeOffIcon = (p: P) => (<svg {...base} {...p}><path d="M3 3l18 18" /><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6 0 9.5 7 9.5 7a17.6 17.6 0 0 1-3.2 4.1M6.2 6.3C3.8 8 2.5 12 2.5 12S6 19 12 19c1.6 0 3-.4 4.3-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>);
export const FlameIcon = (p: P) => (<svg {...base} {...p}><path d="M12 22c4 0 7-2.7 7-6.8C19 10 14 8 14 3c-3 1.5-5 4.6-5 7.5-1-.5-2-1.7-2-3C5.3 9 5 11.6 5 15.2 5 19.3 8 22 12 22Z" /></svg>);
export const ArrowUpRight = (p: P) => (<svg {...base} {...p}><path d="M7 17 17 7M8 7h9v9" /></svg>);
export const ArrowRight = (p: P) => (<svg {...base} {...p}><path d="M5 12h14M13 6l6 6-6 6" /></svg>);
export const ShieldIcon = (p: P) => (<svg {...base} {...p}><path d="M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6L12 3Z" /><path d="m9 12 2 2 4-4" /></svg>);
export const RepeatIcon = (p: P) => (<svg {...base} {...p}><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></svg>);
export const ClockIcon = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>);
export const CheckIcon = (p: P) => (<svg {...base} {...p}><path d="m5 12 5 5 9-10" /></svg>);
export const XIcon = (p: P) => (<svg {...base} {...p}><path d="M6 6l12 12M18 6 6 18" /></svg>);
export const MenuIcon = (p: P) => (<svg {...base} {...p}><path d="M4 7h16M4 12h16M4 17h16" /></svg>);
export const RingIcon = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" strokeDasharray="1.6 1.9" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /></svg>);
export const LedgerIcon = (p: P) => (<svg {...base} {...p}><path d="M4 6h16M4 12h16M4 18h16" /><path d="M9 4v16" /></svg>);
export const GridIcon = (p: P) => (<svg {...base} {...p}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></svg>);
