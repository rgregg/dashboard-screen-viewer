import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ViewState } from "./status.js";

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
}

/**
 * Files for a native image viewer (feh) on the display: an ordered slide list it reloads,
 * and a one-line status it overlays (offline/access banner or "No images found").
 */
export function writeKioskFiles(dataDir: string, liveDir: string, state: ViewState): void {
  const slides = state.images.map((image) => join(liveDir, image.name));
  writeAtomic(join(dataDir, "slides.txt"), slides.map((path) => `${path}\n`).join(""));
  const status = state.banner?.text ?? (state.images.length === 0 ? state.message ?? "" : "");
  writeAtomic(join(dataDir, "status.txt"), status ? `${status}\n` : "");
}
