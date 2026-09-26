// Parses the token encryption key ring from configuration. Kept separate from env.ts so it can be
// tested with any input.
//
// TOKEN_ENCRYPTION_KEYS="v2:<base64>,v1:<base64>": the first key encrypts new data; the others only
// decrypt data written before a rotation. Without it, TOKEN_ENCRYPTION_KEY alone is key "v1".

export interface KeyRing {
  /** Version used for everything encrypted from now on. */
  current: string;
  keys: Map<string, Buffer>;
}

export function parseKeyRing(list: string | undefined, single: string | undefined): KeyRing {
  if (!list) {
    if (!single) throw new Error("set TOKEN_ENCRYPTION_KEYS or TOKEN_ENCRYPTION_KEY");
    return { current: "v1", keys: new Map([["v1", decodeKey(single, "TOKEN_ENCRYPTION_KEY")]]) };
  }

  const keys = new Map<string, Buffer>();
  for (const entry of list.split(",").map((s) => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(":");
    const version = entry.slice(0, sep);
    if (sep < 0 || !/^v\d+$/.test(version)) throw new Error(`TOKEN_ENCRYPTION_KEYS: entries must look like "v2:<base64 key>"`);
    if (keys.has(version)) throw new Error(`TOKEN_ENCRYPTION_KEYS: ${version} appears twice`);
    keys.set(version, decodeKey(entry.slice(sep + 1), `TOKEN_ENCRYPTION_KEYS ${version}`));
  }
  const current = keys.keys().next().value;
  if (!current) throw new Error("TOKEN_ENCRYPTION_KEYS is empty");
  return { current, keys };
}

function decodeKey(base64: string, name: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error(`${name}: must be 32 bytes, base64-encoded`);
  return key;
}
