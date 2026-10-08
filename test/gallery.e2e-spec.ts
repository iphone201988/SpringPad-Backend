// Gallery + signed media against a running API (npm run start:dev).
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { generateChildCode, hashChildCode } from '../src/children/linking.js';
import { putMaster } from '../src/gallery/media.js';

const API = process.env.API_URL ?? 'http://localhost:3001';
const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.3`;
const run = Date.now();

async function call(method: string, url: string, body?: object, token?: string) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : undefined };
}

async function parent(email: string, childCode?: string) {
  await call('POST', '/auth/register', { email, password: 'correct-horse-1', firstName: 'P', lastName: 'Q', childCode });
  const dir = path.join(process.cwd(), 'tmp', 'mail');
  let token = '';
  for (const f of (await readdir(dir)).sort().reverse()) {
    const t = await readFile(path.join(dir, f), 'utf8');
    if (t.startsWith(`To: ${email}`)) { token = t.match(/token=([\w-]+)/)![1]; break; }
  }
  await call('POST', '/auth/verify', { token });
  return (await call('POST', '/auth/login', { email, password: 'correct-horse-1' })).body.token as string;
}

describe('gallery', () => {
  const code = generateChildCode();
  let childId = '', photoId = '', owner = '', stranger = '';

  beforeAll(async () => {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const school = (await db.query(`INSERT INTO school (id, name) VALUES (gen_random_uuid(), 'Gallery E2E') RETURNING id`)).rows[0].id;
    childId = (await db.query(`INSERT INTO child (id, school_id, first_name, last_name) VALUES (gen_random_uuid(), $1, 'Ava', 'E2E') RETURNING id`, [school])).rows[0].id;
    await db.query(`INSERT INTO child_code (id, child_id, code_hash) VALUES (gen_random_uuid(), $1, $2)`, [childId, hashChildCode(code)]);
    const add = async (ref: string, anchor: boolean) => {
      const key = `e2e-${run}/${ref}.png`;
      await putMaster(key, await readFile(path.resolve('../frontend/public/images/portrait-emma.png'))); // same storage the API reads (S3 or MEDIA_DIR)
      return (await db.query(`INSERT INTO image_asset (id, child_id, reference, is_anchor, master_key, width, height) VALUES (gen_random_uuid(), $1, $2, $3, $4, 500, 500) RETURNING id`, [childId, ref, anchor, key])).rows[0].id as string;
    };
    await add('ANCHOR', true);
    photoId = await add('E2E-001', false);
    await db.end();
    owner = await parent(`go+${run}@example.com`, code);
    stranger = await parent(`gs+${run}@example.com`);
  });

  it('lists only non-anchor photos, only for a linked parent', async () => {
    const r = await call('GET', `/children/${childId}/images`, undefined, owner);
    expect(r.body.map((i: { reference: string }) => i.reference)).toEqual(['E2E-001']);
    expect((await call('GET', `/children/${childId}/images`, undefined, stranger)).status).toBe(404);
    expect((await call('GET', `/images/${photoId}`, undefined, stranger)).status).toBe(404);
  });

  it('serves derivatives only through valid, unexpired signatures', async () => {
    const { previewUrl, thumbUrl } = (await call('GET', `/images/${photoId}`, undefined, owner)).body;
    const ok = await call('GET', thumbUrl);
    expect([ok.status, ok.type]).toEqual([200, 'image/webp']);
    expect((await call('GET', previewUrl)).status).toBe(200);
    const tampered = previewUrl.replace(/sig=(.)/, (_: string, c: string) => `sig=${c === 'A' ? 'B' : 'A'}`); // always a different char
    expect((await call('GET', tampered)).status).toBe(404); // tampered
    expect((await call('GET', previewUrl.replace('/preview?', '/thumb?'))).status).toBe(404); // sig is per-variant
    expect((await call('GET', previewUrl.replace(/exp=\d+/, 'exp=1'))).status).toBe(404); // expired
    expect((await call('GET', `${API}/media/${photoId}/master?exp=9999999999&sig=x`)).status).toBe(404); // masters never served
  });

  it('favourites are per parent and access-checked', async () => {
    expect((await call('PUT', `/images/${photoId}/favourite`, undefined, stranger)).status).toBe(404);
    expect((await call('PUT', `/images/${photoId}/favourite`, undefined, owner)).status).toBe(204);
    expect((await call('GET', '/favourites', undefined, owner)).body.map((i: { id: string }) => i.id)).toEqual([photoId]);
    expect((await call('GET', `/images/${photoId}`, undefined, owner)).body.favourite).toBe(true);
    expect((await call('DELETE', `/images/${photoId}/favourite`, undefined, owner)).status).toBe(204);
    expect((await call('GET', '/favourites', undefined, owner)).body).toEqual([]);
  });

  it('publishes the price catalogue', async () => {
    expect((await call('GET', '/catalog')).body.sizes.find((s: { code: string }) => s.code === '5x7').pricePence).toBe(2299);
  });
});
