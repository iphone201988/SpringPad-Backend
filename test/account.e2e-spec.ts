// Account data (Phase 6) against a running API: addresses, display name, email change, order filter.
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:3001';
const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.5`;
const run = Date.now();

async function call(method: string, url: string, body?: object, token?: string) {
  const res = await fetch(API + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function lastToken(kind: string, to: string) {
  const dir = path.join(process.cwd(), 'tmp', 'mail');
  for (const f of (await readdir(dir)).sort().reverse()) {
    const t = await readFile(path.join(dir, f), 'utf8');
    if (t.startsWith(`To: ${to}`) && t.includes(`/${kind}?token=`)) return t.match(/token=([\w-]+)/)![1];
  }
  throw new Error(`no ${kind} email for ${to}`);
}

async function parent(email: string) {
  await call('POST', '/auth/register', { email, password: 'correct-horse-1', firstName: 'P', lastName: 'Q' });
  await call('POST', '/auth/verify', { token: await lastToken('verify', email) });
  return (await call('POST', '/auth/login', { email, password: 'correct-horse-1' })).body.token as string;
}

describe('account data', () => {
  const email = `acc+${run}@example.com`;
  let me = '', other = '';
  beforeAll(async () => {
    me = await parent(email);
    other = await parent(`acc-o+${run}@example.com`);
  });

  it('manages addresses with one default of each kind', async () => {
    const home = { name: 'P Q', line1: '24 Meadow Close', city: 'Greenwood', postcode: 'gw1  2ab' };
    expect((await call('POST', '/addresses', { ...home, postcode: 'NOT A CODE' }, me)).status).toBe(400);
    const a = (await call('POST', '/addresses', home, me)).body;
    expect(a).toMatchObject({ postcode: 'GW1 2AB', isDefaultShipping: true, isDefaultBilling: true }); // first one = defaults
    const b = (await call('POST', '/addresses', { ...home, line1: '1 Work Road', isDefaultShipping: true }, me)).body;
    const list = (await call('GET', '/addresses', undefined, me)).body;
    expect(list.find((x: { id: string }) => x.id === a.id)).toMatchObject({ isDefaultShipping: false, isDefaultBilling: true });
    expect(list.find((x: { id: string }) => x.id === b.id).isDefaultShipping).toBe(true);
    expect((await call('PATCH', `/addresses/${a.id}`, { ...home, city: 'Oakham' }, me)).body).toMatchObject({ city: 'Oakham', isDefaultBilling: true });
    expect((await call('PATCH', `/addresses/${a.id}`, home, other)).status).toBe(404);
    expect((await call('DELETE', `/addresses/${a.id}`, undefined, other)).status).toBe(404);
    expect((await call('DELETE', `/addresses/${a.id}`, undefined, me)).status).toBe(204);
  });

  it('saves a display name', async () => {
    await call('PATCH', '/me', { firstName: 'P', lastName: 'Q', displayName: 'Pea' }, me);
    expect((await call('GET', '/me', undefined, me)).body.displayName).toBe('Pea');
  });

  it('changes email only after the password and a link to the new address', async () => {
    const newEmail = `acc-new+${run}@example.com`;
    expect((await call('POST', '/me/email', { password: 'wrong-password', newEmail }, me)).status).toBe(401);
    expect((await call('POST', '/me/email', { password: 'correct-horse-1', newEmail }, me)).status).toBe(202);
    expect((await call('GET', '/me', undefined, me)).body.email).toBe(email); // unchanged until confirmed
    expect((await call('POST', '/auth/confirm-email', { token: await lastToken('account/verify-email', newEmail) })).status).toBe(204);
    expect((await call('GET', '/me', undefined, me)).body.email).toBe(newEmail);
    expect((await call('POST', '/auth/login', { email: newEmail, password: 'correct-horse-1' })).status).toBe(200);
  });

  it('filters orders and is honest about cards without Stripe', async () => {
    expect((await call('GET', '/orders?status=REFUNDED', undefined, me)).body).toEqual([]);
    if (!process.env.STRIPE_SECRET_KEY) expect((await call('GET', '/payment-methods', undefined, me)).body).toEqual({ available: false, methods: [] });
  });
});
