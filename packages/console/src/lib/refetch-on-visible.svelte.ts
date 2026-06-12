/**
 * Re-runs `refetch` whenever this browser tab becomes visible again.
 *
 * Houdini's in-memory cache never hears about records created in another
 * tab, so pages whose pickers are fed by page-load queries serve stale
 * options until a hard reload. Call this during component init (it registers
 * an $effect) with a closure that re-pulls the relevant query NetworkOnly.
 *
 * Deliberately `visibilitychange` — not window focus — so it fires only when
 * the tab was actually hidden. App-level focus flips (alt-tab from another
 * application, devtools, dismissing a native confirm()) keep the document
 * visible and don't re-trigger it, which keeps heavyweight ref-data queries
 * off the hot path and avoids racing confirm()-guarded mutations.
 */
export function refetchOnVisible(refetch: () => unknown) {
  $effect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });
}
