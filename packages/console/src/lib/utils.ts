import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class lists, resolving conflicts (shadcn convention). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Round a computed money value to the currency's 2-decimal precision. Apply
 * after any multiply/divide before sending to the API so binary-float drift
 * (e.g. `19.99 * 3 === 59.970000000000006`) never reaches the wire, where the
 * API's `isMoney` check rejects anything with more than 2 decimals. Mirrors
 * roundMoney on the API.
 */
export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Format a money value (the literal rupiah amount, up to 2 decimals) for
 * display: "Rp 1,500,000.5". International grouping — comma thousands, dot
 * decimal — with trailing zeros trimmed. Mirrors formatRp on the API.
 */
export function formatMoney(minor: number): string {
  return "Rp " + minor.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * Human label for a status/enum value: "in_transit" → "In transit".
 * Use wherever a raw API enum is shown to the user (status badges,
 * ledger type cells) so casing stays consistent across pages.
 */
export function statusLabel(value: string): string {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Collapse a name to a comparison key for duplicate detection: lowercase and
 * strip everything but letters/digits. Catches the common real-world variants
 * ("Coca-Cola" / "coca cola" / "cocacola") without a fuzzy-match dependency.
 */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Split a search query into lowercase whitespace-separated tokens. Empty/blank
 * queries yield `[]`. Pair with {@link matchesTokens} for AND-token filtering.
 */
export function searchTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * AND-match pre-tokenised search terms against one or more haystack fields:
 * every token must appear (as a substring) in at least one field. This lets a
 * query span fields and word order — "sproc sss" matches a product named
 * "sprocket … sss", and "john 0812" matches a customer by name + phone. Pass
 * the fields you want searchable; null/undefined fields are ignored. Tokenise
 * the query once with {@link searchTokens} rather than per row.
 */
export function matchesTokens(
  tokens: readonly string[],
  ...fields: (string | null | undefined)[]
): boolean {
  if (tokens.length === 0) return true;
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  return tokens.every((t) => haystack.includes(t));
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

/**
 * Safely evaluates a simple arithmetic expression string (e.g., "20+5").
 * Strips all characters except digits, ., +, -, *, /, (, ).
 * Returns null if invalid or evaluating fails.
 */
export function evaluateMath(expr: string): number | null {
  const safeExpr = expr.replace(/[^\d.+\-*/()]/g, "");
  if (!safeExpr) return null;
  try {
    const result = new Function("return " + safeExpr)();
    if (typeof result === "number" && !Number.isNaN(result) && Number.isFinite(result)) {
      return result;
    }
  } catch {
    // Ignore syntax errors from incomplete/invalid math
  }
  return null;
}
