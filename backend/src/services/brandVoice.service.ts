import { prisma } from "../config/database.js";
import type { BrandVoiceBody } from "../schemas/ai.schemas.js";
import { audit } from "./audit.service.js";

const select = { tone: true, audience: true, dos: true, donts: true, samplePost: true, updatedAt: true } as const;

/** The workspace's brand voice, or null if none is set. */
export async function getBrandVoice(workspaceId: string) {
  return prisma.brandVoice.findUnique({ where: { workspaceId }, select });
}

/** Saves the brand voice. All fields empty removes it, so prompts don't carry an empty section. */
export async function saveBrandVoice(workspaceId: string, actorId: string, input: BrandVoiceBody) {
  const empty = Object.values(input).every((v) => v === null);
  const voice = empty
    ? (await prisma.brandVoice.deleteMany({ where: { workspaceId } }), null)
    : await prisma.brandVoice.upsert({
        where: { workspaceId },
        create: { workspaceId, updatedById: actorId, ...input },
        update: { updatedById: actorId, ...input },
        select,
      });
  await audit({ action: empty ? "brand_voice.cleared" : "brand_voice.updated", workspaceId, actorId });
  return voice;
}
