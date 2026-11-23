import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { MAX_IMAGE_BYTES, PreconditionError, imageContentType, type RemoteImage } from "./source.js";

/** Where screenshots are published: the gateway, using a publisher token. */
export interface PublishTarget {
  listImages(): Promise<RemoteImage[]>;
  upload(name: string, data: Buffer, contentType: string): Promise<void>;
  remove(name: string, eTag: string): Promise<void>;
}

export function loadPublishConfig(env: NodeJS.ProcessEnv, argv: string[]) {
  const args: Record<string, string> = {};
  for (const arg of argv) {
    if (arg === "--delete") continue;
    const match = /^--(source-dir|gateway-url|token-file)=(.+)$/.exec(arg);
    if (!match) throw new Error("Use --source-dir=PATH, --gateway-url=URL, --token-file=PATH and optionally --delete");
    args[match[1]] = match[2];
  }
  const sourceDir = args["source-dir"] ?? env.SCREENSHOT_DIR;
  if (!sourceDir) throw new Error("SCREENSHOT_DIR or --source-dir is required");
  const gatewayUrl = args["gateway-url"] ?? env.GATEWAY_URL;
  let url: URL;
  try { url = new URL(gatewayUrl ?? ""); } catch { throw new Error("GATEWAY_URL or --gateway-url must be the gateway's HTTPS URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("GATEWAY_URL or --gateway-url must be the gateway's HTTPS URL");
  }
  const tokenFile = args["token-file"] ?? env.PUBLISHER_TOKEN_FILE;
  if (!tokenFile) throw new Error("PUBLISHER_TOKEN_FILE or --token-file is required");
  return { sourceDir, gatewayUrl: url.href.replace(/\/$/, ""), tokenFile, deleteMissing: argv.includes("--delete") };
}

export async function publishFolder(
  target: PublishTarget,
  sourceDir: string,
  deleteMissing = false,
): Promise<{ uploaded: number; deleted: number }> {
  const files: { name: string; contentType: string }[] = [];
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const contentType = imageContentType(entry.name);
    if (!entry.isFile() || !contentType) continue;
    const stat = await lstat(join(sourceDir, entry.name));
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) {
      throw new Error("Screenshot files must be nonempty regular files no larger than 50 MiB");
    }
    files.push({ name: entry.name, contentType });
  }
  if (deleteMissing && files.length === 0) throw new Error("Refusing to delete remote images from an empty screenshot folder");

  for (const { name, contentType } of files) {
    const data = await readFile(join(sourceDir, name));
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) throw new Error("Screenshot size changed; publish again after capture finishes");
    await target.upload(name, data, contentType);
  }

  let deleted = 0;
  if (deleteMissing) {
    const names = new Set(files.map((file) => file.name));
    for (const image of await target.listImages()) {
      if (names.has(image.name)) continue;
      try {
        await target.remove(image.name, image.eTag);
        deleted++;
      } catch (error) {
        // Replaced since the listing: someone published a newer version, so keep it.
        if (!(error instanceof PreconditionError)) throw error;
      }
    }
  }
  return { uploaded: files.length, deleted };
}
