// Generates per-app favicons, PWA icons, Windows .ico files, and optimized
// wordmark logos from assets/brand/mark.svg + assets/brand/wordmark.png.
// Run from the workspace root: bun run icons
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const markTemplate = await Bun.file(path.join(root, "assets/brand/mark.svg")).text();

// Tile colors follow each app's theme. Console's theme accent
// (oklch(0.52 0.21 264) ≈ #2559DA) is nearly identical to catalog's #1F6FEB
// at favicon size, so console uses a violet-leaning indigo to keep browser
// tabs distinguishable.
const COLORS = {
  console: "#4F46E5",
  catalog: "#1F6FEB",
  pos: "#3F51B5",
  workshop: "#009688",
} as const;

function markSvg(color: string, { rx = 112, scale = 1 } = {}): string {
  return markTemplate
    .replaceAll("{{COLOR}}", color)
    .replaceAll("{{RX}}", String(rx))
    .replaceAll("{{SCALE}}", String(scale));
}

function renderPng(svg: string, size: number): Promise<Buffer> {
  // viewBox is 512 at 72dpi; bump density so the rasterizer works at target size
  return sharp(Buffer.from(svg), { density: (72 * size) / 512 })
    .resize(size, size)
    .png()
    .toBuffer();
}

// ICO container with PNG-compressed entries (supported since Windows Vista).
function packIco(entries: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dirs: Buffer[] = [];
  const blobs: Buffer[] = [];
  let offset = 6 + 16 * entries.length;
  for (const { size, data } of entries) {
    const dir = Buffer.alloc(16);
    dir.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    dir.writeUInt8(size >= 256 ? 0 : size, 1); // height
    dir.writeUInt16LE(1, 4); // color planes
    dir.writeUInt16LE(32, 6); // bits per pixel
    dir.writeUInt32LE(data.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += data.length;
    dirs.push(dir);
    blobs.push(data);
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}

const written: string[] = [];
async function write(relPath: string, data: Buffer | string) {
  const abs = path.join(root, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await Bun.write(abs, data);
  const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
  written.push(`${relPath} (${(bytes / 1024).toFixed(1)} KB)`);
}

async function makeIco(color: string): Promise<Buffer> {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = await Promise.all(
    sizes.map(async (size) => ({ size, data: await renderPng(markSvg(color), size) })),
  );
  return packIco(entries);
}

// --- SvelteKit apps: favicon.svg + favicon.png ---
for (const app of ["console", "catalog"] as const) {
  const svg = markSvg(COLORS[app]);
  await write(`packages/${app}/static/favicon.svg`, svg);
  await write(`packages/${app}/static/favicon.png`, await renderPng(svg, 48));
}

// --- POS: web favicon, PWA icons (incl. maskable), Windows ico ---
{
  const color = COLORS.pos;
  await write("packages/pos/web/favicon.png", await renderPng(markSvg(color), 32));
  for (const size of [192, 512]) {
    await write(`packages/pos/web/icons/Icon-${size}.png`, await renderPng(markSvg(color), size));
    // maskable: full-bleed square, mark shrunk into the safe zone
    const maskable = markSvg(color, { rx: 0, scale: 0.78 });
    await write(`packages/pos/web/icons/Icon-maskable-${size}.png`, await renderPng(maskable, size));
  }
  await write("packages/pos/windows/runner/resources/app_icon.ico", await makeIco(color));
}

// --- Workshop: Windows ico ---
await write("packages/workshop/windows/runner/resources/app_icon.ico", await makeIco(COLORS.workshop));

// --- Wordmark: re-encode the full-res master, write optimized copy to each app ---
{
  const master = path.join(root, "assets/brand/wordmark.png");
  const optimized = await sharp(master)
    .resize({ width: 800, withoutEnlargement: true })
    .png({ palette: true, colors: 16, dither: 0, effort: 10, compressionLevel: 9 })
    .toBuffer();
  for (const dest of [
    "packages/console/static/logo.png",
    "packages/catalog/static/logo.png",
    "packages/pos/assets/logo.png",
    "packages/workshop/assets/logo.png",
  ]) {
    await write(dest, optimized);
  }
}

console.log(`Wrote ${written.length} files:`);
for (const file of written) console.log(`  ${file}`);
