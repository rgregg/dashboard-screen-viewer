import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceTokenHash, parseDeviceHashes, validDeviceToken } from "../src/device-auth.js";

const run = promisify(execFile);

describe("device credential provisioning", () => {
  it("creates a private credential and a hash-only registry without printing or overwriting the credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "device-"));
    const path = join(dir, "office.token");
    const args = ["--import", "tsx", "scripts/create-device.ts", "--device-id=office", `--token-file=${path}`];
    try {
      const { stdout } = await run(process.execPath, args);
      const token = (await readFile(path, "utf8")).trim();
      expect(validDeviceToken(token)).toBe(true);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const rawRegistry = await readFile(`${path}.registry.json`, "utf8");
      expect(parseDeviceHashes(rawRegistry).get("office")?.toString("hex")).toBe(deviceTokenHash(token));
      expect(stdout).not.toContain(token);
      expect(rawRegistry).not.toContain(token);
      await expect(run(process.execPath, args)).rejects.toMatchObject({ code: 1 });
      expect((await readFile(path, "utf8")).trim()).toBe(token);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed or plaintext registries and allows an empty registry to revoke all devices", () => {
    expect(parseDeviceHashes("{}").size).toBe(0);
    for (const raw of ["", "[]", "not-json", '{"office":"supersecret"}', `{"Bad-ID":"${"a".repeat(64)}"}`]) {
      expect(() => parseDeviceHashes(raw)).toThrow(/SHA-256 hashes/);
      expect(() => parseDeviceHashes(raw)).not.toThrow(/supersecret/);
    }
  });
});
