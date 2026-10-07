import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

// Derivatives parents may see. 'original' (the master) is only ever signed for a paid digital entitlement.
export const VARIANTS = { thumb: 600, preview: 1400 } as const;
export type Variant = keyof typeof VARIANTS | 'original';
export const isVariant = (v: string): v is Variant => v in VARIANTS || v === 'original';

const URL_TTL_SECONDS = 5 * 60;
const root = () => path.resolve(process.env.MEDIA_DIR ?? 'storage');
export const masterPath = (key: string) => {
  const p = path.resolve(root(), 'masters', key);
  if (!p.startsWith(path.join(root(), 'masters') + path.sep)) throw new Error('bad master key'); // no ../ escapes
  return p;
};

const sign = (imageId: string, variant: Variant, exp: number) =>
  createHmac('sha256', process.env.MEDIA_SIGNING_KEY ?? '').update(`${imageId}:${variant}:${exp}`).digest('base64url');

/** Short-lived URL scoped to one image + size. Only handed out after the parent_child_link check. */
export function signedUrl(imageId: string, variant: Variant) {
  const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
  return `${process.env.PUBLIC_API_URL}/media/${imageId}/${variant}?exp=${exp}&sig=${sign(imageId, variant, exp)}`;
}

export function verifySignature(imageId: string, variant: Variant, exp: number, sig: string) {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(imageId, variant, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Resized WebP from the private master, generated once and cached on disk. */
export async function derivative(imageId: string, masterKey: string, variant: keyof typeof VARIANTS) {
  const out = path.join(root(), 'derived', variant, `${imageId}.webp`);
  try {
    await stat(out);
  } catch {
    await mkdir(path.dirname(out), { recursive: true });
    await sharp(masterPath(masterKey)).rotate().resize({ width: VARIANTS[variant], withoutEnlargement: true }).webp({ quality: 82 }).toFile(out);
  }
  return readFile(out);
}
