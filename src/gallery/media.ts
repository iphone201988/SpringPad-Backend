import { createHmac, timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp, { type ResizeOptions } from 'sharp';

// Derivatives parents may see. 'original' (the master) is only ever signed for a paid digital entitlement.
export const VARIANTS = { thumb: 600, preview: 1400 } as const;
export type Variant = keyof typeof VARIANTS | 'original';
export const isVariant = (v: string): v is Variant => v in VARIANTS || v === 'original';

const URL_TTL_SECONDS = 5 * 60;
const root = () => path.resolve(process.env.MEDIA_DIR ?? 'storage');
const localPath = (key: string) => {
  const p = path.resolve(root(), key);
  if (!p.startsWith(root() + path.sep) || key.includes('..')) throw new Error('bad media key'); // no ../ escapes
  return p;
};
export const masterPath = (key: string) => localPath(`masters/${key}`);

// Private S3 bucket when AWS_S3_BUCKET is set (credentials/region come from the standard AWS_* env vars); local disk otherwise.
// Objects are never public: the API streams them behind its own signed URLs.
let s3: S3Client | undefined;
const bucket = () => process.env.AWS_S3_BUCKET;
const client = () => (s3 ??= new S3Client({}));

export async function putObject(key: string, body: Buffer, contentType?: string) {
  if (bucket()) return void (await client().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType })));
  await mkdir(path.dirname(localPath(key)), { recursive: true });
  await writeFile(localPath(key), body);
}

/** Object bytes, or null if it doesn't exist. */
export async function getObject(key: string): Promise<Buffer | null> {
  try {
    if (!bucket()) return await readFile(localPath(key));
    const r = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  } catch (e) {
    if (e instanceof NoSuchKey || (e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export const getMaster = async (masterKey: string) => {
  const b = await getObject(`masters/${masterKey}`);
  if (!b) throw new Error(`missing master ${masterKey}`);
  return b;
};
export const putMaster = (masterKey: string, body: Buffer) => putObject(`masters/${masterKey}`, body);

/** Short-lived direct S3 link (null when storing on local disk). Only call after the access check. */
export const s3Url = (key: string, downloadName?: string) =>
  bucket()
    ? getSignedUrl(client(), new GetObjectCommand({
        Bucket: bucket(), Key: key, ResponseCacheControl: 'private, max-age=300',
        ResponseContentDisposition: downloadName && `attachment; filename="${downloadName}"`,
      }), { expiresIn: URL_TTL_SECONDS })
    : Promise.resolve(null);

/** Create the derivative in S3 if missing, without downloading it when it already exists. */
export async function ensureDerivative(imageId: string, masterKey: string, variant: keyof typeof VARIANTS) {
  try {
    await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: derivativeKey(imageId, variant) }));
  } catch {
    await derivative(imageId, masterKey, variant);
  }
}

/** Stored WebP at `key`, built from the master with `resize` on first request. */
export async function cachedWebp(key: string, masterKey: string, resize: ResizeOptions, quality: number) {
  const hit = await getObject(key);
  if (hit) return hit;
  const out = await sharp(await getMaster(masterKey)).rotate().resize(resize).webp({ quality }).toBuffer();
  await putObject(key, out, 'image/webp');
  return out;
}

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

/** Resized WebP from the private master, generated once and cached in storage. */
export const derivativeKey = (imageId: string, variant: keyof typeof VARIANTS) => `derived/${variant}/${imageId}.webp`;
export const derivative = (imageId: string, masterKey: string, variant: keyof typeof VARIANTS) =>
  cachedWebp(derivativeKey(imageId, variant), masterKey, { width: VARIANTS[variant], withoutEnlargement: true }, 82);
