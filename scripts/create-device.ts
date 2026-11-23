import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { DEVICE_ID, deviceTokenHash } from "../src/device-auth.js";

try {
  const args: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--(device-id|token-file)=(.+)$/.exec(arg);
    if (!match) throw new Error("Use --device-id=office-screen --token-file=/secure/path/office-screen.token");
    args[match[1]] = match[2];
  }
  const id = args["device-id"];
  const path = args["token-file"];
  if (!id || !DEVICE_ID.test(id) || !path) throw new Error("A lowercase device ID (letters, digits, hyphens) and --token-file are required");
  const token = `${id}.${randomBytes(32).toString("base64url")}`;
  await writeFile(path, `${token}\n`, { flag: "wx", mode: 0o600 });
  try {
    await writeFile(`${path}.registry.json`, JSON.stringify({ [id]: deviceTokenHash(token) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch {
    await unlink(path);
    throw new Error("Could not create the device registry; existing files are never overwritten");
  }
  console.log("Created the device token file and its .registry.json hash registry. Transfer only the token file to the display.");
} catch {
  console.error("Device creation failed. Supply a valid --device-id and --token-file in an existing writable directory; neither output file may already exist.");
  process.exitCode = 1;
}
