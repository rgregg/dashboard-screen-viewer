import { describe, it, expect } from "vitest";
import { loadConfig, loadGatewayConfig } from "../src/config.js";

const base = { BLOB_CONTAINER_URL: "https://account.blob.core.windows.net/screens?sp=rl&sig=secret" };

describe("loadConfig", () => {
  it("reads values from env", () => {
    const c = loadConfig({ ...base, ROTATION_SECONDS: "20", POLL_SECONDS: "120", DATA_DIR: "/d", PORT: "8080" }, []);
    expect(c).toMatchObject({ blobContainerUrl: base.BLOB_CONTAINER_URL, rotationSeconds: 20, pollSeconds: 120, dataDir: "/d", port: 8080 });
  });
  it("lets CLI --key=value override env", () => {
    const c = loadConfig({ ...base, ROTATION_SECONDS: "20" }, ["--rotation-seconds=5"]);
    expect(c.rotationSeconds).toBe(5);
  });
  it("defaults to 60-second polling without any Entra configuration", () => {
    const c = loadConfig(base, []);
    expect(c.pollSeconds).toBe(60);
    expect(c.rotationSeconds).toBe(15);
  });
  it("clamps pollSeconds below 30 up to 30", () => {
    expect(loadConfig({ ...base, POLL_SECONDS: "5" }, []).pollSeconds).toBe(30);
  });
  it("rejects rotationSeconds <= 0 or NaN", () => {
    expect(() => loadConfig({ ...base, ROTATION_SECONDS: "0" }, [])).toThrow(/rotationSeconds/);
    expect(() => loadConfig({ ...base, ROTATION_SECONDS: "abc" }, [])).toThrow(/rotationSeconds/);
  });
  it("requires an HTTPS container SAS URL without leaking invalid credentials", () => {
    expect(() => loadConfig({}, [])).toThrow(/BLOB_CONTAINER_URL/);
    for (const url of ["garbage?sig=secret", "http://account/screens?sig=secret", "https://account/?sig=secret", "https://account/screens"]) {
      expect(() => loadConfig({ BLOB_CONTAINER_URL: url }, [])).toThrow(/HTTPS container SAS URL/);
      expect(() => loadConfig({ BLOB_CONTAINER_URL: url }, [])).not.toThrow(/secret/);
    }
  });
  it("allows a CLI container URL to override the environment", () => {
    const url = "https://other.blob.core.windows.net/screens?sig=other";
    expect(loadConfig(base, [`--blob-container-url=${url}`]).blobContainerUrl).toBe(url);
  });

  it("configures the gateway without a SAS and accepts command-line overrides", () => {
    expect(loadConfig({ GATEWAY_URL: "https://gateway.example/", DEVICE_TOKEN_FILE: "/secure/display.token" }, []))
      .toMatchObject({ source: "gateway", gatewayUrl: "https://gateway.example", deviceTokenFile: "/secure/display.token" });
    expect(loadConfig({}, ["--gateway-url=https://gateway.example", "--device-token-file=/secure/display.token"]))
      .toMatchObject({ source: "gateway", deviceTokenFile: "/secure/display.token" });
    expect(() => loadConfig({ GATEWAY_URL: "https://gateway.example" }, [])).toThrow(/DEVICE_TOKEN_FILE/);
    expect(() => loadConfig({ DEVICE_TOKEN_FILE: "/token" }, [])).toThrow(/GATEWAY_URL/);
    expect(() => loadConfig({ ...base, GATEWAY_URL: "https://gateway.example", DEVICE_TOKEN_FILE: "/token" }, [])).toThrow(/not both/);
  });

  it("rejects insecure or credential-bearing gateway URLs without exposing the credential", () => {
    for (const url of ["http://gateway.example", "https://user:secret@gateway.example", "https://gateway.example?token=secret", "https://gateway.example/#secret"]) {
      expect(() => loadConfig({ GATEWAY_URL: url, DEVICE_TOKEN_FILE: "/token" }, [])).toThrow(/HTTPS URL/);
      expect(() => loadConfig({ GATEWAY_URL: url, DEVICE_TOKEN_FILE: "/token" }, [])).not.toThrow(/secret/);
    }
  });

  it("requires a plain container URL and hash-only devices for the managed identity gateway", () => {
    const env = {
      STORAGE_CONTAINER_URL: "https://account.blob.core.windows.net/screenshots",
      GATEWAY_DEVICE_TOKENS: JSON.stringify({ office: "a".repeat(64) }),
    };
    expect(loadGatewayConfig(env)).toMatchObject({ storageContainerUrl: env.STORAGE_CONTAINER_URL, port: 8080 });
    expect(() => loadGatewayConfig({ ...env, STORAGE_CONTAINER_URL: base.BLOB_CONTAINER_URL })).toThrow(/STORAGE_CONTAINER_URL/);
    expect(() => loadGatewayConfig({ ...env, GATEWAY_DEVICE_TOKENS: undefined })).toThrow(/GATEWAY_DEVICE_TOKENS/);
    expect(() => loadGatewayConfig({ ...env, PORT: "65536" })).toThrow(/PORT/);
    expect(() => loadGatewayConfig({ ...env, STORAGE_CONTAINER_URL: "https://account.blob.core.windows.net/" })).toThrow(/single Blob container/);
  });
});
