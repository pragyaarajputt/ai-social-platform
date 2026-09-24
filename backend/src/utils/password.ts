import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended argon2id parameters (19 MiB memory, 2 iterations, 1 lane).
// @node-rs/argon2 uses argon2id by default.
const options = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, options);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a real hash verification that always fails. Used when a login email doesn't exist,
 * so response time doesn't reveal which emails have accounts.
 */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  await verify(await dummyHash, password);
}
