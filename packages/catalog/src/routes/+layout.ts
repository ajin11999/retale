import { env } from "$env/dynamic/public";
import type { CatalogSnapshot } from "$lib/snapshot";
import type { LayoutLoad } from "./$types";

// The catalog is one static JSON snapshot on Vercel Blob. Loading it here, in
// a universal load, makes it available to every route — SSR'd on first paint,
// then reused for client-side navigation.
export const load: LayoutLoad = async ({ fetch }) => {
  const url = env.PUBLIC_CATALOG_SNAPSHOT_URL;
  if (!url) {
    return {
      snapshot: null as CatalogSnapshot | null,
      error: "Catalog is not configured — set PUBLIC_CATALOG_SNAPSHOT_URL.",
    };
  }
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return {
        snapshot: null as CatalogSnapshot | null,
        error: `Catalog is unavailable (HTTP ${res.status}).`,
      };
    }
    const snapshot = (await res.json()) as CatalogSnapshot;
    return { snapshot, error: null as string | null };
  } catch (e) {
    return {
      snapshot: null as CatalogSnapshot | null,
      error: `Catalog could not be loaded: ${(e as Error).message}`,
    };
  }
};
