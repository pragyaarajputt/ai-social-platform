// `npm run tokens:key-status`: how many stored secrets use each encryption key version. After a
// rotation, the old key can be removed from TOKEN_ENCRYPTION_KEYS once nothing uses it any more.
import { prisma } from "../config/database.js";
import { keyVersionCounts } from "../jobs/keyRotation.js";
import { currentKeyVersion } from "../utils/tokenCrypto.js";

const counts = await keyVersionCounts();
const current = currentKeyVersion();
console.log(`Current key: ${current}`);
if (Object.keys(counts).length === 0) console.log("No encrypted secrets stored yet.");
for (const [version, count] of Object.entries(counts)) {
  console.log(`  ${version}: ${count}${version === current ? " (current)" : " — still to re-encrypt; keep this key until it reaches 0"}`);
}
await prisma.$disconnect();
