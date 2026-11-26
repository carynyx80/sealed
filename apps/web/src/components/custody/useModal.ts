"use client";
// Shared behaviour for bottom sheets / dialogs: scroll lock, focus in + restore, Tab trap, Esc, the browser
// Back button (or Android back gesture) closes, and the on-screen keyboard never covers the focused field.
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const HISTORY_KEY = "__sealedSheet";

export function useModal(open: boolean, panel: RefObject<HTMLElement | null>, { onClose, locked = false }: { onClose: () => void; locked?: boolean }) {
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusT = setTimeout(() => panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus() ?? panel.current?.focus(), 30);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!lockedRef.current) closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        items[items.length - 1]!.focus();
      } else if (!e.shiftKey && (i === -1 || i === items.length - 1)) {
        e.preventDefault();
        items[0]!.focus();
      }
    };

    // Back closes the sheet: push a marker entry (keeping the router's own state) and pop it on close.
    const marker = Math.random().toString(36).slice(2);
    let pushed = false;
    try {
      window.history.pushState({ ...(window.history.state ?? {}), [HISTORY_KEY]: marker }, "");
      pushed = true;
    } catch {
      /* history unavailable (sandboxed frame) */
    }
    const onPop = () => {
      pushed = false;
      if (lockedRef.current) {
        // Can't close right now (wallet prompt open): put the marker back.
        try {
          window.history.pushState({ ...(window.history.state ?? {}), [HISTORY_KEY]: marker }, "");
          pushed = true;
        } catch {
          /* ignore */
        }
        return;
      }
      closeRef.current();
    };

    // On-screen keyboard: cap the panel to the visual viewport and keep the focused field in view.
    const vv = window.visualViewport;
    const typing = () => {
      const a = document.activeElement as HTMLElement | null;
      return !!a && !!panel.current?.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    };
    const onVV = () => {
      const el = panel.current;
      if (!vv || !el) return;
      // Only while a field in the sheet has focus (that is when a keyboard can be up) and not while pinch-zoomed:
      // the part of the layout viewport the visual viewport doesn't cover is the keyboard (iOS). Android resizes
      // the layout viewport instead, which makes this 0.
      const kb = typing() && Math.abs(vv.scale - 1) < 0.01 ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
      el.style.setProperty("--kb", `${kb}px`);
      el.style.setProperty("--vvh", `${Math.round(kb ? vv.height : window.innerHeight)}px`);
    };
    const onFocusIn = (e: FocusEvent) => {
      onVV();
      const t = e.target as HTMLElement | null;
      if (!t || !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      setTimeout(() => {
        onVV();
        t.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 300);
    };
    const onFocusOut = () => setTimeout(onVV, 50);
    onVV();
    vv?.addEventListener("resize", onVV);
    vv?.addEventListener("scroll", onVV);
    const p = panel.current;
    p?.addEventListener("focusin", onFocusIn);
    p?.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);

    return () => {
      clearTimeout(focusT);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
      vv?.removeEventListener("resize", onVV);
      vv?.removeEventListener("scroll", onVV);
      p?.removeEventListener("focusin", onFocusIn);
      p?.removeEventListener("focusout", onFocusOut);
      document.body.style.overflow = prevOverflow;
      // Closed from the UI: drop our marker entry, but only if it is still the current one (not after a navigation).
      if (pushed && (window.history.state as Record<string, unknown> | null)?.[HISTORY_KEY] === marker) window.history.back();
      restore?.focus?.({ preventScroll: true });
    };
  }, [open, panel]);
}
