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
  return "Rp " + Math.round(minor).toLocaleString("id-ID");
}
