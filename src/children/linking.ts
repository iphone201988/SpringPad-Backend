import { randomInt } from 'node:crypto';
import { hashToken } from '../auth/tokens.js';
import type { PrismaService } from '../prisma.service.js';

// Crockford base32: no I, L, O, U, so codes on ID cards can't be misread.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** New card code, e.g. "SP-K73Q-F9XM-2CAB": 12 random characters = 60 bits (brute force is hopeless under rate limits). */
export function generateChildCode() {
  const c = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `SP-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

/** What parents type → canonical form: case, spaces, dashes and look-alike letters don't matter. */
export function normalizeChildCode(input: string) {
  const s = input.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.length === 14 && s.startsWith('SP') ? s.slice(2) : s; // "SP" prefix is optional when typing
}

export const hashChildCode = (input: string) => hashToken(`child-code:${normalizeChildCode(input)}`);

export const audit = (db: PrismaService, action: string, data: { customerId?: string; childId?: string; ip?: string | null; detail?: object }) =>
  db.auditLog.create({ data: { action, ...data, ip: data.ip ?? null } });

/**
 * Claims a single-use code and links the child to the parent. Returns the child id, or null if the code
 * is unknown, used or expired (callers show one generic message for all three).
 */
export async function redeemCodeHash(db: PrismaService, customerId: string, codeHash: string, ip?: string | null) {
  const claimed = await db.childCode.updateManyAndReturn({
    where: { codeHash, redeemedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    data: { redeemedAt: new Date(), redeemedBy: customerId },
  });
  if (!claimed.length) {
    await audit(db, 'CODE_REDEEM_FAILED', { customerId, ip });
    return null;
  }
  const { childId } = claimed[0];
  await db.parentChildLink.upsert({
    where: { customerId_childId: { customerId, childId } },
    create: { customerId, childId },
    update: { status: 'ACTIVE', verifiedAt: new Date() },
  });
  await audit(db, 'CODE_REDEEMED', { customerId, childId, ip, detail: { codeId: claimed[0].id } });
  return childId;
}
