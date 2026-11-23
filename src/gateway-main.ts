import { ContainerClient } from "@azure/storage-blob";
import { ManagedIdentityCredential } from "@azure/identity";
import { BlobSource } from "./blob.js";
import { loadGatewayConfig } from "./config.js";
import { createGateway } from "./gateway.js";

try {
  const cfg = loadGatewayConfig(process.env);
  const credential = new ManagedIdentityCredential({ clientId: cfg.managedIdentityClientId });
  const source = new BlobSource(new ContainerClient(cfg.storageContainerUrl, credential, {
    retryOptions: { maxTries: 3, tryTimeoutInMs: 30_000 },
  }));
  const server = createGateway(source, cfg.devices, cfg.publishers);
  server.listen(cfg.port, "0.0.0.0", () => console.log(`Download gateway listening on port ${cfg.port}`));
  const shutdown = () => {
    server.close();
    const timer = setTimeout(() => server.closeAllConnections(), 10_000);
    timer.unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch {
  console.error("Gateway configuration invalid; check STORAGE_CONTAINER_URL, GATEWAY_DEVICE_TOKENS, GATEWAY_PUBLISHER_TOKENS, AZURE_CLIENT_ID and PORT");
  process.exitCode = 1;
}
