import { GatewaySource } from "../src/gateway-client.js";
import { loadPublishConfig, publishFolder } from "../src/publish.js";

try {
  const cfg = loadPublishConfig(process.env, process.argv.slice(2));
  const target = new GatewaySource(cfg.gatewayUrl, cfg.tokenFile, fetch, "publisher");
  const result = await publishFolder(target, cfg.sourceDir, cfg.deleteMissing);
  console.log(`Uploaded ${result.uploaded} images; deleted ${result.deleted} images.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Publishing failed");
  process.exitCode = 1;
}
