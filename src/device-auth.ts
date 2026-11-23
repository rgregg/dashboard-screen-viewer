import { createHash, timingSafeEqual } from "node:crypto";

export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEVICE_TOKEN = /^([a-z0-9][a-z0-9-]{0,62})\.[A-Za-z0-9_-]{43}$/;

export function deviceTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function validDeviceToken(token: string): boolean {
  return DEVICE_TOKEN.test(token);
}

export function parseDeviceHashes(raw: string | undefined, setting = "GATEWAY_DEVICE_TOKENS"): Map<string, Buffer> {
  const invalid = () => new Error(`${setting} must be a JSON object mapping IDs to SHA-256 hashes`);
  let value: unknown;
  try { value = JSON.parse(raw ?? ""); } catch { throw invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const entries = Object.entries(value);
  if (entries.some(([id, hash]) => !DEVICE_ID.test(id) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
    throw invalid();
  }
  return new Map(entries.map(([id, hash]) => [id, Buffer.from(hash as string, "hex")]));
}

export function authenticateDevice(authorization: string | undefined, devices: ReadonlyMap<string, Buffer>): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const token = authorization.slice(7);
  const match = DEVICE_TOKEN.exec(token);
  if (!match) return false;
  const expected = devices.get(match[1]);
  return expected !== undefined && timingSafeEqual(expected, Buffer.from(deviceTokenHash(token), "hex"));
}
