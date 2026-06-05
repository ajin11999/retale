// Local on-disk storage for uploaded assets. This is a LAN-only deployment
// (see CLAUDE.md), so assets that are only consumed inside the network — like
// the business logo — live on the API's own disk rather than in cloud Blob.
//
// Override the location with UPLOADS_DIR; otherwise it sits under the API
// process's working directory.

import { mkdir } from "node:fs/promises";
import path from "node:path";

/** Root directory for locally-stored uploads. */
export const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(process.cwd(), "uploads");

/**
 * Absolute path to the single business-logo file. There is exactly one logo,
 * so a fixed filename is enough; callers bust browser caches with a version
 * query param keyed off the settings row's updatedAt.
 */
export const BUSINESS_LOGO_PATH = path.join(UPLOADS_DIR, "business", "logo.png");

/** Create a directory (and parents) if it does not already exist. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
