// Basket → checkout → paid order → entitlement, against a running API in simulated-payment mode
// (STRIPE_SECRET_KEY empty). Run: npm run test:e2e
import 'dotenv/config';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { generateChildCode, hashChildCode } from '../src/children/linking.js';
import { masterPath } from '../src/gallery/media.js';

const API = process.env.API_URL ?? 'http://localhost:3001';
const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.4`;
const run = Date.now();

async function call(method: string, url: string, body?: object, token?: string) {
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, headers: res.headers, body: type.includes('json') ? await res.json() : undefined };
}

async function parent(email: string, childCode?: string) {
  await call('POST', '/auth/register', { email, password: 'correct-horse-1', firstName: 'P', lastName: 'Q', childCode });
  const dir = path.join(process.cwd(), 'tmp', 'mail');
  for (const f of (await readdir(dir)).sort().reverse()) {
    const t = await readFile(path.join(dir, f), 'utf8');
    if (t.startsWith(`To: ${email}`)) { await call('POST', '/auth/verify', { token: t.match(/token=([\w-]+)/)![1] }); break; }
  }
  return (await call('POST', '/auth/login', { email, password: 'correct-horse-1' })).body.token as string;
}

describe.skipIf(!!process.env.STRIPE_SECRET_KEY)('shop (simulated payments)', () => {
  const code = generateChildCode();
  let photoId = '', buyer = '', other = '';

  beforeAll(async () => {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const school = (await db.query(`INSERT INTO school (id, name) VALUES (gen_random_uuid(), 'Shop E2E') RETURNING id`)).rows[0].id;
    const child = (await db.query(`INSERT INTO child (id, school_id, first_name, last_name) VALUES (gen_random_uuid(), $1, 'Mia', 'E2E') RETURNING id`, [school])).rows[0].id;
    await db.query(`INSERT INTO child_code (id, child_id, code_hash) VALUES (gen_random_uuid(), $1, $2)`, [child, hashChildCode(code)]);
    const key = `shop-e2e-${run}/1.png`;
    await mkdir(path.dirname(masterPath(key)), { recursive: true });
    await copyFile(path.resolve('../frontend/public/images/portrait-emma.png'), masterPath(key));
    photoId = (await db.query(`INSERT INTO image_asset (id, child_id, reference, master_key, width, height) VALUES (gen_random_uuid(), $1, 'SHOP-001', $2, 500, 500) RETURNING id`, [child, key])).rows[0].id;
    await db.end();
    buyer = await parent(`sb+${run}@example.com`, code);
    other = await parent(`so+${run}@example.com`);
  });

  it('prices on the server and rejects bad lines', async () => {
    expect((await call('POST', '/basket', { imageId: photoId, sizeCode: '8x10', frameCode: 'gold', mat: true, quantity: 2 }, other)).status).toBe(404); // not their child
    expect((await call('POST', '/basket', { imageId: photoId, sizeCode: '99x99', frameCode: 'gold', mat: false }, buyer)).status).toBe(400);
    expect((await call('POST', '/basket', { imageId: photoId, sizeCode: '5x7', frameCode: 'oak', mat: false, unitPricePence: 1 }, buyer)).status).toBe(400); // no client prices
    const b = (await call('POST', '/basket', { imageId: photoId, sizeCode: '8x10', frameCode: 'gold', mat: true, quantity: 2 }, buyer)).body;
    expect(b.lines[0]).toMatchObject({ title: '8 × 10 Classic Gold Print with Mat', unitPricePence: 3499, linePricePence: 6998 });
    const d = (await call('POST', '/basket', { imageId: photoId, sizeCode: 'digital', frameCode: 'black', mat: true, quantity: 1 }, buyer)).body;
    expect(d.lines[1]).toMatchObject({ digital: true, unitPricePence: 1499 }); // frame + mat ignored for digital
    expect(d.totalPence).toBe(6998 + 1499);
  });

  it('checks out into a paid order, empties the basket and grants the digital file', async () => {
    const r = await call('POST', '/checkout', { name: 'P Q', email: `sb+${run}@example.com`, address: '1 Test Street, London' }, buyer);
    expect(r.status).toBe(200);
    const order = (await call('GET', `/orders/${r.body.orderId}`, undefined, buyer)).body;
    expect(order).toMatchObject({ status: 'PAID', totalPence: 8497 });
    expect(order.number).toBeGreaterThanOrEqual(10001);
    expect((await call('GET', '/basket', undefined, buyer)).body.lines).toEqual([]);
    expect((await call('GET', `/orders/${r.body.orderId}`, undefined, other)).status).toBe(404);
    expect((await call('GET', '/orders', undefined, other)).body).toEqual([]);

    const [download] = (await call('GET', '/downloads', undefined, buyer)).body;
    const file = await call('GET', download.url);
    expect([file.status, file.type]).toEqual([200, 'image/png']);
    expect(file.headers.get('content-disposition')).toContain('attachment');
    expect((await call('GET', '/downloads', undefined, other)).body).toEqual([]);
  });

  it('refuses an empty basket and unsigned webhooks', async () => {
    expect((await call('POST', '/checkout', { name: 'P Q', email: 'x@example.com', address: 'Somewhere' }, buyer)).status).toBe(400);
    expect((await call('POST', '/webhooks/stripe', { type: 'checkout.session.completed' })).status).toBe(400);
  });
});
