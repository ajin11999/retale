import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class lists, resolving conflicts (shadcn convention). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Format an integer minor-unit money value for display.
 * Retale stores money as integer minor units (see docs/design-decisions.md);
 * adjust the scale here if the minor unit is ever sub-rupiah.
 */
export function formatMoney(minor: number): string {
  return "Rp " + Math.round(minor).toLocaleString("id-ID");
}

/**
 * Collapse a name to a comparison key for duplicate detection: lowercase and
 * strip everything but letters/digits. Catches the common real-world variants
 * ("Coca-Cola" / "coca cola" / "cocacola") without a fuzzy-match dependency.
 */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** A node in a self-referential forest — only the fields needed for a path. */
export interface TreePathNode {
  id: string;
  name: string;
  parentId?: string | null;
}

/**
 * Build an id → breadcrumb-path map for a hierarchical forest (locations,
 * categories, …), e.g. "Warehouse › Shelf 2 › Level 1". This disambiguates
 * same-named children under different parents (Shelf 1 › Level 1 vs
 * Shelf 2 › Level 1), which a bare name cannot. Input may be in any order;
 * cycles or missing ancestors fall back to the bare name.
 */
export function treePathMap(
  nodes: readonly TreePathNode[],
): Map<string, string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cache = new Map<string, string>();
  const build = (id: string, seen: Set<string>): string => {
    const cached = cache.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    if (!node) return "Unknown";
    const parentId = node.parentId ?? null;
    const path =
      !parentId || seen.has(parentId) || !byId.has(parentId)
        ? node.name
        : `${build(parentId, seen.add(id))} › ${node.name}`;
    cache.set(id, path);
    return path;
  };
  for (const n of nodes) build(n.id, new Set([n.id]));
  return cache;
}
