<script lang="ts">
  import { graphql } from "$houdini";
  import { formatMoney } from "$lib/utils";
  import Button from "$lib/components/ui/button.svelte";
  import { Printer, X, Eye, FileText, DollarSign, Barcode, User, Share2, Download } from "@lucide/svelte";
  import { PDFDocument } from "pdf-lib";
  import { domToCanvas } from "modern-screenshot";
  import type { PageData } from "./$types";

  graphql(`
    query RfqPrintDetail($id: ID!) {
      rfq(id: $id) {
        id
        rfqNumber
        vendorId
        snapshotVendorName
        date
        dueDate
        status
        memo
        termsAndConditions
        createdAt
        updatedAt
        sections {
          id
          name
          sortOrder
        }
        items {
          id
          sectionId
          requisitionItemId
          variantId
          description
          qtyRequested
          targetUnitCostMinor
          quotedUnitCostMinor
          sortOrder
        }
      }
    }
  `);

  graphql(`
    query RfqPrintRefData($vendorId: ID) {
      businessSettings {
        name
        logoUrl
        updatedAt
      }
      vendors {
        id
        name
      }
      codesForVendor(vendorId: $vendorId) {
        variantId
        code
      }
      products(includeArchived: true) {
        id
        name
        kind
        variants {
          id
          sku
          barcode
          label
          costMinor
        }
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const RfqDetail = $derived(data.RfqPrintDetail);
  const RefData = $derived(data.RfqPrintRefData);

  const rfq = $derived($RfqDetail.data?.rfq);
  const businessSettings = $derived($RefData.data?.businessSettings);

  $effect(() => {
    if (rfq?.vendorId) {
      RefData.fetch({ variables: { vendorId: rfq.vendorId } });
    }
  });

  const products = $derived(
    ($RefData.data?.products ?? []).filter((p: any) => p.kind !== "bundle")
  );
  const vendorCodes = $derived($RefData.data?.codesForVendor ?? []);

  // Map variantId -> Vendor part number code lookup
  const vendorCodeMap = $derived(
    new Map(vendorCodes.map((vc: any) => [vc.variantId, vc.code]))
  );

  // ---- Printing & Paper Options Toggles ----
  let paperSize = $state<"A4" | "Letter" | "Legal">("A4"); // Default paper size: A4
  let showVendor = $state(true); // Show vendor name toggle (default: true)
  let showNote = $state(false);
  let showCosts = $state(false); // Target cost, subtotal, total (default: false)
  let showBarcode = $state(false); // Show barcode under product name (default: false)

  let sharing = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  const items = $derived(rfq?.items ?? []);
  const printedAt = `${new Date().toLocaleDateString("en-CA")} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  // Map variantId to variant details (name without SKU, sku, barcode)
  const getVariantInfo = (variantId: string | null | undefined) => {
    if (!variantId) return null;
    for (const p of products) {
      for (const v of p.variants) {
        if (v.id === variantId) {
          const mainName = v.label ? `${p.name} (${v.label})` : p.name;
          const code = v.barcode?.trim() || v.sku;
          return {
            name: mainName,
            sku: v.sku,
            barcode: code,
          };
        }
      }
    }
    return null;
  };

  // Resolve item display line:
  // If vendor code is specified: use vendor variant code
  // Fallback to product name if there is no vendor code specified
  const lineDisplay = (item: (typeof items)[number]) => {
    if (item.variantId) {
      const info = getVariantInfo(item.variantId);
      const isVendorChosen = Boolean(rfq?.vendorId);

      if (isVendorChosen) {
        const mappedCode = vendorCodeMap.get(item.variantId);
        if (mappedCode?.trim()) {
          return {
            name: mappedCode.trim(),
            barcode: info?.barcode ?? null,
          };
        }
      }

      if (info) {
        return {
          name: info.name,
          barcode: info.barcode,
        };
      }
    }
    return {
      name: item.description ?? "—",
      barcode: null,
    };
  };

  const totalTargetCost = $derived(
    items.reduce((sum, i) => sum + i.qtyRequested * i.targetUnitCostMinor, 0)
  );

  // Generate A4/Letter/Legal PDF document Blob matching the exact HTML view 1:1 using modern-screenshot + pdf-lib
  async function generatePdfBlob(): Promise<Blob> {
    const el = document.getElementById("printable-document");
    if (!el) throw new Error("Printable document element not found");

    // Capture DOM layout as high-resolution canvas with full oklch() / Tailwind v4 support
    const canvas = await domToCanvas(el, {
      scale: 2,
      backgroundColor: "#ffffff",
    });

    const imgData = canvas.toDataURL("image/png");
    const pdfDoc = await PDFDocument.create();

    const isLetter = paperSize === "Letter";
    const isLegal = paperSize === "Legal";
    const pdfW = isLetter ? 612 : isLegal ? 612 : 595.28;
    const pdfH = isLetter ? 792 : isLegal ? 1008 : 841.89;

    const pngImage = await pdfDoc.embedPng(imgData);
    const imgW = pngImage.width;
    const imgH = pngImage.height;

    const renderW = pdfW;
    const renderH = (imgH * renderW) / imgW;

    if (renderH <= pdfH) {
      const page = pdfDoc.addPage([pdfW, pdfH]);
      page.drawImage(pngImage, {
        x: 0,
        y: pdfH - renderH,
        width: renderW,
        height: renderH,
      });
    } else {
      const pageCanvasH = (imgW * pdfH) / pdfW;
      let pageOffset = 0;

      while (pageOffset < imgH) {
        const pageCanvas = document.createElement("canvas");
        pageCanvas.width = imgW;
        pageCanvas.height = Math.min(pageCanvasH, imgH - pageOffset);

        const ctx = pageCanvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
          ctx.drawImage(
            canvas,
            0,
            pageOffset,
            imgW,
            pageCanvas.height,
            0,
            0,
            imgW,
            pageCanvas.height
          );
        }

        const pageImgData = pageCanvas.toDataURL("image/png");
        const pagePng = await pdfDoc.embedPng(pageImgData);
        const pageRenderH = (pageCanvas.height * pdfW) / imgW;

        const page = pdfDoc.addPage([pdfW, pdfH]);
        page.drawImage(pagePng, {
          x: 0,
          y: pdfH - pageRenderH,
          width: pdfW,
          height: pageRenderH,
        });

        pageOffset += pageCanvasH;
      }
    }

    const pdfBytes = await pdfDoc.save();
    return new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" });
  }

  async function downloadPdf() {
    if (!rfq) return;
    try {
      const blob = await generatePdfBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `rfq-${rfq.rfqNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      feedback = { ok: true, text: `Downloaded rfq-${rfq.rfqNumber}.pdf successfully.` };
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }

  async function sharePdf() {
    if (!rfq) return;
    sharing = true;
    feedback = null;
    try {
      const blob = await generatePdfBlob();
      const fileName = `rfq-${rfq.rfqNumber}.pdf`;
      const file = new File([blob], fileName, { type: "application/pdf" });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: `RFQ ${rfq.rfqNumber}`,
          text: `Request for Quotation ${rfq.rfqNumber} — see attached PDF.`,
        });
        feedback = { ok: true, text: "PDF shared successfully." };
      } else {
        await downloadPdf();
        feedback = {
          ok: true,
          text: `PDF downloaded (${fileName}). Attach it in your WhatsApp, Email, or Chat application to send.`,
        };
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return; // dismissed
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      sharing = false;
    }
  }
</script>

<svelte:head>
  <title>{rfq ? `Print ${rfq.rfqNumber}` : "Print RFQ"} · Retale Console</title>
</svelte:head>

<!-- Sticky Printing Options & Send PDF Control Bar (Hidden when printing) -->
<div class="sticky top-0 z-50 bg-card border-b p-4 shadow-sm space-y-3 print:hidden">
  <div class="flex items-center justify-between flex-wrap gap-4">
    <!-- Printing Toggles & Paper Selector -->
    <div class="flex items-center gap-5 flex-wrap">
      <div class="flex items-center gap-2">
        <Eye class="size-4 text-primary" />
        <span class="font-semibold text-sm">Printing Options:</span>
      </div>

      <!-- Paper Size Selector (Default: A4) -->
      <div class="flex items-center gap-1.5 text-xs font-medium">
        <FileText class="size-3.5 text-muted-foreground" />
        <span>Paper:</span>
        <select
          bind:value={paperSize}
          class="h-8 rounded-md border border-input bg-background px-2 text-xs font-medium shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="A4">A4 (210 × 297 mm)</option>
          <option value="Letter">Letter (8.5 × 11 in)</option>
          <option value="Legal">Legal (8.5 × 14 in)</option>
        </select>
      </div>

      <label class="flex items-center gap-2 text-xs font-medium cursor-pointer select-none">
        <input
          type="checkbox"
          bind:checked={showVendor}
          class="size-4 rounded border-gray-300 text-primary focus:ring-primary"
        />
        <User class="size-3.5 text-muted-foreground" />
        <span>Show Vendor Name</span>
      </label>

      <label class="flex items-center gap-2 text-xs font-medium cursor-pointer select-none">
        <input
          type="checkbox"
          bind:checked={showNote}
          class="size-4 rounded border-gray-300 text-primary focus:ring-primary"
        />
        <FileText class="size-3.5 text-muted-foreground" />
        <span>Show Note / Memo</span>
      </label>

      <label class="flex items-center gap-2 text-xs font-medium cursor-pointer select-none">
        <input
          type="checkbox"
          bind:checked={showCosts}
          class="size-4 rounded border-gray-300 text-primary focus:ring-primary"
        />
        <DollarSign class="size-3.5 text-muted-foreground" />
        <span>Show Target Cost &amp; Totals</span>
      </label>

      <label class="flex items-center gap-2 text-xs font-medium cursor-pointer select-none">
        <input
          type="checkbox"
          bind:checked={showBarcode}
          class="size-4 rounded border-gray-300 text-primary focus:ring-primary"
        />
        <Barcode class="size-3.5 text-muted-foreground" />
        <span>Show Barcode</span>
      </label>
    </div>

    <!-- Actions: Send PDF Attachment, Download PDF, Print -->
    <div class="flex items-center gap-2">
      <Button
        size="sm"
        class="bg-emerald-600 hover:bg-emerald-700 text-white"
        disabled={sharing}
        onclick={sharePdf}
      >
        <Share2 class="mr-1.5 size-4" />
        {sharing ? "Preparing PDF…" : "Send PDF Attachment"}
      </Button>

      <Button size="sm" variant="outline" onclick={downloadPdf}>
        <Download class="mr-1.5 size-4" /> Download PDF
      </Button>

      <Button size="sm" variant="outline" onclick={() => window.print()}>
        <Printer class="mr-1.5 size-4" /> Print
      </Button>

      <Button size="sm" variant="ghost" onclick={() => window.close()}>
        <X class="size-4" />
      </Button>
    </div>
  </div>

  {#if feedback}
    <div class="rounded border px-3 py-1.5 text-xs flex items-center justify-between {feedback.ok ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-amber-50 text-amber-800 border-amber-200'}">
      <span>{feedback.text}</span>
      <button onclick={() => feedback = null} class="text-xs font-semibold ml-2 hover:underline">Dismiss</button>
    </div>
  {/if}
</div>

<!-- Printable Document Area -->
<div
  class="min-h-screen bg-muted/20 py-8 px-4 print:py-0 print:px-0 print:bg-white text-[1.15rem] leading-relaxed"
  style="--paper-size-css: {paperSize === 'Letter' ? 'letter portrait' : paperSize === 'Legal' ? 'legal portrait' : 'A4 portrait'};"
>
  {#if $RfqDetail.fetching && !rfq}
    <div class="p-12 text-center text-base text-muted-foreground">Loading RFQ print preview…</div>
  {:else if $RfqDetail.errors?.length || !rfq}
    <div class="p-12 text-center text-base text-destructive">
      {$RfqDetail.errors?.[0]?.message ?? "RFQ not found"}
    </div>
  {:else}
    <div
      id="printable-document"
      class="max-w-4xl mx-auto p-8 bg-card rounded-lg border shadow-sm print:shadow-none print:border-none print:p-0 print:max-w-none text-foreground font-sans space-y-6"
    >
      
      <!-- Document Header -->
      <div class="flex items-start justify-between border-b pb-4">
        <div class="space-y-2">
          <h1 class="text-3xl font-extrabold tracking-tight">REQUEST FOR QUOTATION</h1>
          
          <!-- Business Logo under RFQ heading text -->
          <div class="py-1">
            {#if businessSettings?.logoUrl}
              <img
                src={`/settings/logo?v=${encodeURIComponent(businessSettings.updatedAt ?? "")}`}
                alt={businessSettings.name ?? "Business Logo"}
                class="h-10 w-auto max-w-[180px] object-contain"
              />
            {:else}
              <img src="/logo.png" alt="Retale" class="h-7 w-auto object-contain" />
            {/if}
          </div>

          {#if showVendor && rfq.snapshotVendorName}
            <p class="text-base font-semibold text-foreground">
              Vendor: <span class="text-primary font-bold">{rfq.snapshotVendorName}</span>
            </p>
          {/if}
        </div>

        <div class="text-right space-y-0.5">
          <h2 class="text-2xl font-bold font-mono text-primary">{rfq.rfqNumber}</h2>
          <p class="text-sm text-muted-foreground">
            Date: <span class="font-medium text-foreground">{rfq.date}</span>
          </p>
          <p class="text-xs text-muted-foreground">
            Printed: <span class="font-medium text-foreground">{printedAt}</span>
          </p>
          {#if rfq.dueDate}
            <p class="text-sm text-muted-foreground">
              Due Date: <span class="font-medium text-foreground">{rfq.dueDate}</span>
            </p>
          {/if}
        </div>
      </div>

      <!-- Optional Memo / Internal Note (Shown only when toggled) -->
      {#if showNote && rfq.memo?.trim()}
        <div class="rounded-md border bg-muted/30 p-3.5 space-y-1 text-sm">
          <p class="font-bold uppercase tracking-wider text-muted-foreground text-xs">Internal Memo / Notes</p>
          <p class="text-foreground whitespace-pre-wrap">{rfq.memo.trim()}</p>
        </div>
      {/if}

      <!-- Striped Items Table (1.5x Bigger Table Text with Precision Right-Side Border Fix) -->
      <div class="rounded-lg border border-slate-300 print:border-slate-400">
        <table class="w-full text-left print-table">
          <thead class="bg-muted/80 text-muted-foreground font-bold text-sm uppercase">
            <tr>
              <th class="w-14 px-3.5 py-2.5 text-center">#</th>
              <th class="px-3.5 py-2.5">Product / Item Code</th>
              <th class="w-28 px-3.5 py-2.5 text-right">Qty</th>
              {#if showCosts}
                <th class="w-40 px-3.5 py-2.5 text-right">Target Cost</th>
                <th class="w-44 px-3.5 py-2.5 text-right">Target Total</th>
              {/if}
            </tr>
          </thead>
          <tbody>
            {#each items as item, idx (item.id)}
              {@const disp = lineDisplay(item)}
              <tr class="odd:bg-white even:bg-slate-100/80 print:even:bg-slate-100 hover:bg-slate-200/50 print:hover:bg-transparent">
                <!-- 1. Numbering -->
                <td class="px-3.5 py-2 text-center font-mono text-base text-muted-foreground">{idx + 1}</td>
                
                <!-- 2. Product Name / Variant Code & Optional Barcode (break-words prevents overflow) -->
                <td class="px-3.5 py-2 break-words max-w-md">
                  <p class="font-bold text-[1.35rem] text-foreground leading-snug break-words">{disp.name}</p>
                  {#if showBarcode && disp.barcode}
                    <p class="text-sm text-muted-foreground font-mono mt-0.5 break-all" style="color: #6b7280;">
                      Barcode: {disp.barcode}
                    </p>
                  {/if}
                </td>

                <!-- 3. Quantity (1.5x Bigger Text: 1.35rem) -->
                <td class="px-3.5 py-2 text-right tabular-nums font-mono font-bold text-[1.35rem]">{item.qtyRequested}</td>

                <!-- Optional Target Cost & Target Total -->
                {#if showCosts}
                  <td class="px-3.5 py-2 text-right tabular-nums font-mono text-base">
                    {formatMoney(item.targetUnitCostMinor)}
                  </td>
                  <td class="px-3.5 py-2 text-right tabular-nums font-mono font-bold text-[1.35rem]">
                    {formatMoney(item.qtyRequested * item.targetUnitCostMinor)}
                  </td>
                {/if}
              </tr>
            {:else}
              <tr>
                <td colspan={showCosts ? 5 : 3} class="px-4 py-8 text-center text-muted-foreground text-base">
                  No line items present.
                </td>
              </tr>
            {/each}
          </tbody>

          <!-- Optional Subtotal & Total Footer Rows -->
          {#if showCosts && items.length > 0}
            <tfoot class="bg-muted/40 font-medium">
              <tr>
                <td colspan="4" class="px-3.5 py-2 text-right text-xs uppercase text-muted-foreground">Subtotal</td>
                <td class="px-3.5 py-2 text-right tabular-nums font-mono font-semibold text-base">
                  {formatMoney(totalTargetCost)}
                </td>
              </tr>
              <tr class="font-bold">
                <td colspan="4" class="px-3.5 py-2.5 text-right text-sm uppercase text-foreground">Total Target Cost</td>
                <td class="px-3.5 py-2.5 text-right tabular-nums font-mono text-2xl text-primary">
                  {formatMoney(totalTargetCost)}
                </td>
              </tr>
            </tfoot>
          {/if}
        </table>
      </div>

      <!-- Terms and Conditions Section (if available) -->
      {#if rfq.termsAndConditions?.trim()}
        <div class="pt-4 border-t space-y-1">
          <p class="text-xs font-bold uppercase tracking-wider text-muted-foreground">Terms &amp; Conditions</p>
          <p class="text-sm text-muted-foreground whitespace-pre-wrap">{rfq.termsAndConditions.trim()}</p>
        </div>
      {/if}

    </div>
  {/if}
</div>

<style>
  .print-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    box-sizing: border-box;
  }
  .print-table th,
  .print-table td {
    border-bottom: 1px solid #cbd5e1;
    border-right: 1px solid #e2e8f0;
    box-sizing: border-box;
  }
  .print-table th:last-child,
  .print-table td:last-child {
    border-right: none;
  }
  .print-table tbody tr:last-child td {
    border-bottom: none;
  }

  @media print {
    @page {
      size: var(--paper-size-css, A4 portrait);
      margin: 10mm 12mm 10mm 12mm;
    }
    body {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    .print-table {
      width: 100% !important;
      border-collapse: separate !important;
      border-spacing: 0 !important;
      box-sizing: border-box !important;
    }
    .print-table th,
    .print-table td {
      border-bottom: 1px solid #cbd5e1 !important;
      border-right: 1px solid #cbd5e1 !important;
      box-sizing: border-box !important;
    }
    .print-table th:last-child,
    .print-table td:last-child {
      border-right: none !important;
    }
    tr:nth-child(even) {
      background-color: #f1f5f9 !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
  }
</style>
