// Child linking against a running API (npm run start:dev). Creates its own school/children/codes directly in the DB.
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { generateChildCode, hashChildCode } from '../src/children/linking.js';

const API = process.env.API_URL ?? 'http://localhost:3001';
const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.2`;
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
    const text = await readFile(path.join(dir, f), 'utf8');
    if (text.startsWith(`To: ${to}`) && text.includes(`/${kind}?token=`)) return text.match(/token=([\w-]+)/)![1];
  }
  throw new Error(`no ${kind} email for ${to}`);
}

/** Sign up → verify → log in; returns the session token. */
async function parent(email: string, childCode?: string) {
  expect((await call('POST', '/auth/register', { email, password: 'correct-horse-1', firstName: 'P', lastName: 'Q', childCode })).status).toBe(202);
  expect((await call('POST', '/auth/verify', { token: await lastToken('verify', email) })).status).toBe(204);
  return (await call('POST', '/auth/login', { email, password: 'correct-horse-1' })).body.token as string;
}

const names = (r: { body: { firstName: string }[] }) => r.body.map((c) => c.firstName).sort();

describe('child linking', () => {
  const codeA = generateChildCode();
  const codeB = generateChildCode();
  let emmaId = '', leoId = '', parentA = '';

  beforeAll(async () => {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const school = (await db.query(`INSERT INTO school (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`, [`E2E School ${run}`])).rows[0].id;
    const child = async (name: string, code: string) => {
      const id = (await db.query(`INSERT INTO child (id, school_id, first_name, last_name) VALUES (gen_random_uuid(), $1, $2, 'E2E') RETURNING id`, [school, name])).rows[0].id;
      await db.query(`INSERT INTO child_code (id, child_id, code_hash) VALUES (gen_random_uuid(), $1, $2)`, [id, hashChildCode(code)]);
      return id as string;
    };
    emmaId = await child('Emma', codeA);
    leoId = await child('Leo', codeB);
    await db.end();
  });

  it('redeems the sign-up code only after email verification', async () => {
    parentA = await parent(`a+${run}@example.com`, codeA);
    expect(names(await call('GET', '/children', undefined, parentA))).toEqual(['Emma']);
  });

  it('redeems a code typed loosely, once', async () => {
    const loose = codeB.replace('SP-', '').replaceAll('-', ' ').toLowerCase();
    expect((await call('POST', '/children/redeem', { code: loose }, parentA)).body.firstName).toBe('Leo');
    expect((await call('POST', '/children/redeem', { code: codeB }, parentA)).status).toBe(400);
    expect((await call('POST', '/children/redeem', { code: 'SP-0000-0000-0000' }, parentA)).status).toBe(400);
    expect(names(await call('GET', '/children', undefined, parentA))).toEqual(['Emma', 'Leo']);
  });

  it('lets a linked parent invite a guardian for one child; only the invited email can accept', async () => {
    const guardianEmail = `g+${run}@example.com`;
    const stranger = await parent(`s+${run}@example.com`);
    expect((await call('POST', `/children/${emmaId}/guardians`, { email: guardianEmail }, stranger)).status).toBe(404);
    expect((await call('POST', `/children/${emmaId}/guardians`, { email: guardianEmail }, parentA)).status).toBe(202);
    const invite = await lastToken('guardian-invite', guardianEmail);
    expect((await call('POST', '/guardian-invites/accept', { token: invite }, stranger)).status).toBe(400);
    const guardian = await parent(guardianEmail);
    expect((await call('POST', '/guardian-invites/accept', { token: invite }, guardian)).body.firstName).toBe('Emma');
    expect(names(await call('GET', '/children', undefined, guardian))).toEqual(['Emma']); // not Leo
    expect((await call('POST', '/guardian-invites/accept', { token: invite }, guardian)).status).toBe(400); // single use
  });

  it('requires a session and never exposes other children', async () => {
    expect((await call('GET', '/children')).status).toBe(401);
    expect((await call('POST', `/children/${leoId}/guardians`, { email: 'x@example.com' })).status).toBe(401);
    expect((await call('POST', '/children/not-a-uuid/guardians', { email: 'x@example.com' }, parentA)).status).toBe(400);
  });
});
