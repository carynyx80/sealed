import type { CSSProperties } from "react";

/**
 * Scroll affordance for horizontally scrolling boxes (code blocks, wide tables). Two "local" paper covers travel with
 * the content and hide two fixed edge shadows while you are at that edge; once there is more to see, the shadow on that
 * side shows. Pure CSS, so it works on the server render and needs no scroll listeners.
 */
export function scrollShade(bg = "var(--sheet)"): CSSProperties {
  return {
    backgroundColor: bg,
    backgroundImage: [
      `linear-gradient(to right, ${bg} 35%, transparent)`,
      `linear-gradient(to left, ${bg} 35%, transparent)`,
      "radial-gradient(farthest-side at 0 50%, rgba(15,15,13,0.16), rgba(15,15,13,0))",
      "radial-gradient(farthest-side at 100% 50%, rgba(15,15,13,0.16), rgba(15,15,13,0))",
    ].join(", "),
    backgroundPosition: "left center, right center, left center, right center",
    backgroundRepeat: "no-repeat",
    backgroundSize: "40px 100%, 40px 100%, 14px 100%, 14px 100%",
    backgroundAttachment: "local, local, scroll, scroll",
  };
}
