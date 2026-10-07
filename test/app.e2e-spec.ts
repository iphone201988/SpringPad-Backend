// End-to-end auth flow against a running API (npm run start:dev), reading emails from tmp/mail.
// Run: npm run test:e2e   (API_URL overrides http://localhost:3001)
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:3001';
// A fresh fake client IP per run so the per-IP rate limits don't trip on repeated runs.
const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.1`;

async function call(method: string, url: string, body?: object, token?: string) {
  const res = await fetch(API + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function lastLink(kind: 'verify' | 'reset-password', to: string) {
  const dir = path.join(process.cwd(), 'tmp', 'mail');
  for (const f of (await readdir(dir)).sort().reverse()) {
    const text = await readFile(path.join(dir, f), 'utf8');
    if (text.startsWith(`To: ${to}`) && text.includes(`/${kind}?token=`)) return text.match(/token=([\w-]+)/)![1];
  }
  throw new Error(`no ${kind} email for ${to}`);
}

describe('auth flow', () => {
  const email = `e2e+${Date.now()}@example.com`;
  const password = 'correct-horse-1';
  let session = '';

  it('validates input', async () => {
    expect((await call('POST', '/auth/register', { email, password: 'short', firstName: 'A', lastName: 'B' })).status).toBe(400);
    expect((await call('POST', '/auth/register', { email, password, firstName: 'A', lastName: 'B', isAdmin: true })).status).toBe(400);
  });

  it('registers but refuses login until verified', async () => {
    expect((await call('POST', '/auth/register', { email, password, firstName: 'E2E', lastName: 'Parent' })).status).toBe(202);
    const r = await call('POST', '/auth/login', { email, password });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NOT_VERIFIED');
  });

  it('verifies once', async () => {
    const token = await lastLink('verify', email);
    expect((await call('POST', '/auth/verify', { token })).status).toBe(204);
    expect((await call('POST', '/auth/verify', { token })).status).toBe(400);
  });

  it('logs in, reads and updates the profile', async () => {
    expect((await call('POST', '/auth/login', { email, password: 'wrong-password' })).status).toBe(401);
    const r = await call('POST', '/auth/login', { email: email.toUpperCase(), password });
    expect(r.status).toBe(200);
    session = r.body.token;
    expect((await call('GET', '/me', undefined, session)).body.email).toBe(email);
    expect((await call('PATCH', '/me', { firstName: 'Renamed', lastName: 'Parent' }, session)).body.firstName).toBe('Renamed');
    expect((await call('GET', '/me')).status).toBe(401);
  });

  it('resets the password and signs out everywhere', async () => {
    expect((await call('POST', '/auth/forgot-password', { email })).status).toBe(202);
    const token = await lastLink('reset-password', email);
    expect((await call('POST', '/auth/reset-password', { token, password: 'new-password-2' })).status).toBe(204);
    expect((await call('GET', '/me', undefined, session)).status).toBe(401);
    expect((await call('POST', '/auth/login', { email, password: 'new-password-2' })).status).toBe(200);
  });
});
