// Vendor-catalog LLM extraction over an OpenAI-compatible Chat Completions
// endpoint. One `fetch` client, no per-provider SDK: the same call works
// against OpenAI, DeepSeek, and Gemini's OpenAI-compat endpoint by swapping
// `LLM_BASE_URL` / `LLM_MODEL`; Claude is reached through an OpenAI-compatible
// gateway (e.g. OpenRouter or LiteLLM) since its native API speaks a different
// protocol.
//
//   LLM_BASE_URL=https://api.openai.com/v1   (or DeepSeek / Gemini-compat / OpenRouter)
//   LLM_API_KEY=...
//   LLM_MODEL=gpt-4o-mini
//
// Failure modes (stable codes, surfaced to the console as toasts):
// - NOT_CONFIGURED  — env missing (nothing to call).
// - LLM_UNREACHABLE — DNS / refused / timeout. Fail fast, no local fallback:
//   the clerk falls back to manual entry or CSV import.
// - LLM_REJECTED    — provider answered 4xx/5xx (bad key, quota, ...).
// - PROCESSING_FAILED — provider answered but the JSON didn't validate.

import { env } from "../lib/env.ts";
import { isMoney } from "../lib/money.ts";

export type CatalogExtractErrorCode =
  | "NOT_CONFIGURED"
  | "LLM_UNREACHABLE"
  | "LLM_REJECTED"
  | "PROCESSING_FAILED";

export class CatalogExtractError extends Error {
  constructor(
    public code: CatalogExtractErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CatalogExtractError";
  }
}

/** One raw row as extracted — validation/normalization happens in the import service. */
export interface ExtractedCatalogRow {
  vendorCode: string;
  name: string;
  unitText: string;
  priceMinor: number | null;
  moq: number | null;
  note: string;
}

export interface ExtractResult {
  rows: ExtractedCatalogRow[];
  modelUsed: string;
  tokenUsage: unknown;
}

const SYSTEM_PROMPT = [
  "You extract vendor pricelist rows from document text or images.",
  "Return ONLY a JSON object of the shape {\"items\":[{\"vendorCode\":string,\"name\":string,\"unitText\":string,\"price\":number|null,\"moq\":number|null,\"note\":string}]}.",
  "Rules:",
  "- name is the product name as printed (required, non-empty).",
  "- vendorCode is the vendor's SKU / part number / article code (\"\" when absent).",
  "- unitText is the unit as printed (pcs, dus, koli, roll, kg, ...) (\"\" when absent).",
  "- price is the IDR unit price as a plain number, no separators (null when absent or unreadable). Never invent a price.",
  "- moq is the minimum order quantity as an integer (null when absent).",
  "- note holds pack-size hints, validity dates, discount text (\"\" when absent).",
  "- Skip headers, footers, totals, and terms-and-conditions lines.",
  "- IDR only: ignore any row priced in another currency.",
].join("\n");

function config(): { baseUrl: string; apiKey: string; model: string } {
  const baseUrl = env.llmBaseUrl?.trim().replace(/\/+$/, "");
  const apiKey = env.llmApiKey?.trim();
  const model = env.llmModel?.trim();
  if (!baseUrl || !apiKey || !model) {
    throw new CatalogExtractError(
      "NOT_CONFIGURED",
      "LLM ingest is not configured (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL). Enter rows manually or import a CSV.",
    );
  }
  return { baseUrl, apiKey, model };
}

function normalizeItem(raw: unknown): ExtractedCatalogRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim().slice(0, 300) : "";
  if (!name) return null;
  const price =
    typeof r.price === "number" && isMoney(r.price) && r.price >= 0 ? r.price : null;
  const moq =
    typeof r.moq === "number" && Number.isInteger(r.moq) && r.moq > 0 ? r.moq : null;
  return {
    vendorCode: typeof r.vendorCode === "string" ? r.vendorCode.trim().slice(0, 100) : "",
    name,
    unitText: typeof r.unitText === "string" ? r.unitText.trim().slice(0, 50) : "",
    priceMinor: price,
    moq,
    note: typeof r.note === "string" ? r.note.trim().slice(0, 1000) : "",
  };
}

type ChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

async function chatComplete(parts: ChatPart[]): Promise<ExtractResult> {
  const { baseUrl, apiKey, model } = config();
  let res: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: parts },
          ],
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    throw new CatalogExtractError(
      "LLM_UNREACHABLE",
      `Pricelist AI is unreachable (${e instanceof Error ? e.message : "network error"}). Check the connection, or enter rows manually / import a CSV.`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CatalogExtractError(
      "LLM_REJECTED",
      `Pricelist AI rejected the request (HTTP ${res.status}). ${body.slice(0, 200)}`,
    );
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new CatalogExtractError("PROCESSING_FAILED", "Pricelist AI returned a non-JSON response.");
  }
  const content = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (typeof p === "object" && p !== null && "text" in p ? String((p as { text: unknown }).text) : "")).join("") : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CatalogExtractError("PROCESSING_FAILED", "Pricelist AI returned invalid JSON.");
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) {
    throw new CatalogExtractError("PROCESSING_FAILED", "Pricelist AI returned an unexpected shape (expected {items:[...]}).");
  }
  const rows = items.map(normalizeItem).filter((r): r is ExtractedCatalogRow => r !== null);
  const usage = (data as { usage?: unknown })?.usage ?? null;
  return { rows, modelUsed: model, tokenUsage: usage };
}

/** Extract rows from plain text (digital-PDF text layer, CSV fallback, OCR text). */
export function extractCatalogFromText(text: string): Promise<ExtractResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new CatalogExtractError("PROCESSING_FAILED", "No text to extract from.");
  // Cap input to keep token usage bounded (~30k chars ≈ large pricelist).
  return chatComplete([{ type: "text", text: trimmed.slice(0, 30_000) }]);
}

/** Extract rows from page images (scans, photos of printed lists, WhatsApp images). */
export function extractCatalogFromImages(
  images: { dataBase64: string; mediaType: string }[],
): Promise<ExtractResult> {
  if (images.length === 0) {
    throw new CatalogExtractError("PROCESSING_FAILED", "No images to extract from.");
  }
  const capped = images.slice(0, 10);
  const parts: ChatPart[] = [
    { type: "text", text: `Extract the pricelist rows from these ${capped.length} page image(s).` },
    ...capped.map((img): ChatPart => ({
      type: "image_url",
      image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` },
    })),
  ];
  return chatComplete(parts);
}

/**
 * Liveness probe for the Settings page: `GET {base}/models` with the key.
 * Returns true when the endpoint answers 2xx. Never throws — false means
 * "unreachable or misconfigured", and the Extraction path will report the
 * precise code when actually used.
 */
export async function checkLlmHealth(): Promise<boolean> {
  try {
    const { baseUrl, apiKey } = config();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
