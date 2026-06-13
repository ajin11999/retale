import { describe, expect, test } from "bun:test";
import { type OcrWord, parseInvoiceWords, parseMoneyId } from "./invoice-parse.ts";

// Build a positioned word. Rows are separated by y; columns by x0.
function w(text: string, x0: number, y0: number, confidence = 90): OcrWord {
  return { text, confidence, bbox: { x0, y0, x1: x0 + text.length * 10, y1: y0 + 20 } };
}

describe("parseMoneyId (whole-rupiah minor units, id-ID)", () => {
  test("dot is the thousands separator", () => {
    expect(parseMoneyId("25.000")).toBe(25000);
    expect(parseMoneyId("3.500")).toBe(3500);
    expect(parseMoneyId("1.234.567")).toBe(1234567);
    expect(parseMoneyId("12.500.000")).toBe(12500000);
  });
  test("strips a currency prefix", () => {
    expect(parseMoneyId("Rp 25.000")).toBe(25000);
    expect(parseMoneyId("IDR1.000")).toBe(1000);
  });
  test("comma is the decimal separator; sub-rupiah rounds", () => {
    expect(parseMoneyId("1.234.567,89")).toBe(1234568);
    expect(parseMoneyId("3,5")).toBe(4);
  });
  test("a bare comma group still reads as thousands", () => {
    expect(parseMoneyId("25,000")).toBe(25000);
  });
  test("plain integers and non-numbers", () => {
    expect(parseMoneyId("100")).toBe(100);
    expect(parseMoneyId("abc")).toBeNull();
    expect(parseMoneyId("")).toBeNull();
  });
});

describe("parseInvoiceWords", () => {
  test("extracts description / qty / unit cost from item rows", () => {
    const words = [
      w("Bearing", 10, 40), w("6204ZZ", 120, 40), w("4", 250, 40), w("25.000", 320, 40),
      w("Oil", 10, 90), w("seal", 50, 90), w("TC", 110, 90), w("10", 250, 90), w("3.500", 320, 90),
    ];
    const lines = parseInvoiceWords(words);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      recognized: true, description: "Bearing 6204ZZ", qty: 4, unitCostMinor: 25000,
    });
    expect(lines[1]).toMatchObject({
      recognized: true, description: "Oil seal TC", qty: 10, unitCostMinor: 3500,
    });
  });

  test("Qty | Price | Amount → picks the unit price (qty×price ≈ amount)", () => {
    const words = [w("Item", 10, 40), w("2", 200, 40), w("10.000", 280, 40), w("20.000", 380, 40)];
    const [line] = parseInvoiceWords(words);
    expect(line).toMatchObject({ qty: 2, unitCostMinor: 10000 });
  });

  test("single number ≥100 reads as price (qty defaults 1); <100 reads as qty", () => {
    expect(parseInvoiceWords([w("Washer", 10, 40), w("500", 220, 40)])[0]).toMatchObject({
      qty: 1, unitCostMinor: 500,
    });
    expect(parseInvoiceWords([w("Nut", 10, 40), w("5", 220, 40)])[0]).toMatchObject({
      qty: 5, unitCostMinor: null,
    });
  });

  test("low-confidence rows come back unrecognized with blank fields + raw hint", () => {
    const words = [w("blah", 10, 40, 30), w("12.000", 200, 40, 30)];
    const [line] = parseInvoiceWords(words);
    expect(line).toMatchObject({
      recognized: false, description: "", qty: null, unitCostMinor: null,
    });
    expect(line?.raw).toContain("12.000");
  });

  test("rows with no numbers (headers/addresses) are dropped", () => {
    expect(parseInvoiceWords([w("PURCHASE", 10, 40), w("ORDER", 130, 40)])).toHaveLength(0);
  });
});
