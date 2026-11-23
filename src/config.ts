import { parseDeviceHashes } from "./device-auth.js";

interface DisplayConfig {
  rotationSeconds: number;
  pollSeconds: number;
  dataDir: string;
  port: number;
}

type SourceConfig =
  | { source: "gateway"; gatewayUrl: string; deviceTokenFile: string; blobContainerUrl?: never }
  | { source: "blob"; blobContainerUrl: string; gatewayUrl?: never; deviceTokenFile?: never };

export type Config = DisplayConfig & SourceConfig;

const MIN_POLL_SECONDS = 30;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function positiveNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: string[]): Config {
  const args = parseArgs(argv);
  const pick = (cli: string, envKey: string): string | undefined => args[cli] ?? env[envKey];

  const gatewayUrl = pick("gateway-url", "GATEWAY_URL");
  const deviceTokenFile = pick("device-token-file", "DEVICE_TOKEN_FILE");
  const blobContainerUrl = pick("blob-container-url", "BLOB_CONTAINER_URL");
  if (gatewayUrl && blobContainerUrl) throw new Error("Set GATEWAY_URL or BLOB_CONTAINER_URL, not both");
  let source: SourceConfig;
  if (gatewayUrl) {
    if (!deviceTokenFile) throw new Error("DEVICE_TOKEN_FILE is required with GATEWAY_URL");
    source = { source: "gateway", gatewayUrl: validateHttpsUrl(gatewayUrl, "GATEWAY_URL").href.replace(/\/$/, ""), deviceTokenFile };
  } else {
    if (deviceTokenFile) throw new Error("GATEWAY_URL is required with DEVICE_TOKEN_FILE");
    source = { source: "blob", blobContainerUrl: validateContainerUrl(blobContainerUrl) };
  }
  const rotationSeconds = positiveNumber("rotationSeconds", pick("rotation-seconds", "ROTATION_SECONDS") ?? "15");
  const pollSeconds = Math.max(MIN_POLL_SECONDS, positiveNumber("pollSeconds", pick("poll-seconds", "POLL_SECONDS") ?? "60"));

  return {
    ...source,
    rotationSeconds,
    pollSeconds,
    dataDir: pick("data-dir", "DATA_DIR") ?? "./data",
    port: positiveNumber("port", pick("port", "PORT") ?? "8080"),
  };
}

function validateHttpsUrl(raw: string | undefined, setting: string): URL {
  let url: URL;
  try { url = new URL(raw ?? ""); } catch { throw new Error(`${setting} must be an HTTPS URL without credentials, query or fragment`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${setting} must be an HTTPS URL without credentials, query or fragment`);
  }
  return url;
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv) {
  const storageUrl = validateHttpsUrl(env.STORAGE_CONTAINER_URL, "STORAGE_CONTAINER_URL");
  if (!/^\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\/?$/.test(storageUrl.pathname)) {
    throw new Error("STORAGE_CONTAINER_URL must identify a single Blob container");
  }
  const port = positiveNumber("PORT", env.PORT ?? "8080");
  if (!Number.isInteger(port) || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
  return {
    storageContainerUrl: storageUrl.href,
    managedIdentityClientId: env.AZURE_CLIENT_ID,
    devices: parseDeviceHashes(env.GATEWAY_DEVICE_TOKENS),
    // Publishers may upload and delete images; displays only read. Absent means no publishers.
    publishers: parseDeviceHashes(env.GATEWAY_PUBLISHER_TOKENS ?? "{}", "GATEWAY_PUBLISHER_TOKENS"),
    port,
  };
}

export function validateContainerUrl(raw: string | undefined, setting = "BLOB_CONTAINER_URL"): string {
  if (!raw) throw new Error(`${setting} is required`);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${setting} must be an HTTPS container SAS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      !url.pathname.replace(/\//g, "") || !url.searchParams.get("sig")) {
    throw new Error(`${setting} must be an HTTPS container SAS URL`);
  }
  return raw;
}
