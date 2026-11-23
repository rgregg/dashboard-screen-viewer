import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { GatewaySource } from "./gateway-client.js";
import { ImageCache } from "./cache.js";
import { SyncEngine } from "./sync.js";
import { createServer } from "./server.js";
import { writeKioskFiles } from "./kiosk-files.js";

const cfg = loadConfig(process.env, process.argv.slice(2));
const publicDir = fileURLToPath(new URL("../public", import.meta.url));

// Load the Azure SDK only for direct-SAS mode; gateway-mode displays run on distro Node versions it doesn't support.
const source = cfg.source === "gateway"
  ? new GatewaySource(cfg.gatewayUrl, cfg.deviceTokenFile)
  : await import("./blob.js").then(({ BlobSource, createContainerClient }) =>
      new BlobSource(createContainerClient(cfg.blobContainerUrl)));
const cache = new ImageCache(join(cfg.dataDir, "images"));
const engine = new SyncEngine({ source, cache }, cfg);
const server = createServer(engine, cfg, publicDir, () => cache.liveDir);
engine.on("state", (state) => {
  try {
    writeKioskFiles(cfg.dataDir, cache.liveDir, state);
  } catch {
    console.error("Could not write kiosk slide list or status");
  }
});

server.listen(cfg.port, "127.0.0.1", () => {
  console.log(`Dashboard viewer on http://127.0.0.1:${cfg.port}`);
  engine.start();
});

function shutdown(): void {
  engine.stop();
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
