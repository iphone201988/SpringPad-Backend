// Shared by the admin e2e tests: HTTP calls with a per-person fake IP, mail lookup, and a full staff sign-in.
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { StaffAuthService } from '../src/admin/staff-auth.js';
import { MailService } from '../src/mail.service.js';
import { PrismaService } from '../src/prisma.service.js';

export const API = process.env.API_URL ?? 'http://localhost:3001';
export const run = Date.now();
export let ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.6`;

export async function call(method: string, url: string, body?: object, token?: string) {
  const res = await fetch(API + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export async function lastMailTo(email: string) {
  const dir = path.join(process.cwd(), 'tmp', 'mail');
  for (const f of (await readdir(dir)).sort().reverse()) {
    const t = await readFile(path.join(dir, f), 'utf8');
    if (t.startsWith(`To: ${email}`)) return t;
  }
  throw new Error(`no mail to ${email}`);
}

/** Creates a staff account directly, then signs in through the API like a person would. */
export async function staffSession(role: 'SUPERADMIN' | 'STAFF') {
  ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${role === 'STAFF' ? 7 : 6}`; // each person signs in from their own IP (5/min auth limit)
  const email = `e2e-${role.toLowerCase()}-${run}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const db = new PrismaService();
  const s = await db.staffUser.create({ data: { email, name: 'E2E', role } });
  const link = await new StaffAuthService(db, new MailService()).issueInvite(s.id);
  await db.$disconnect();
  const token = new URL(link).searchParams.get('token')!;
  expect((await call('POST', '/admin/auth/set-password', { token, password: 'a-long-staff-password' })).status).toBe(204);
  expect((await call('POST', '/admin/auth/set-password', { token, password: 'a-long-staff-password' })).status).toBe(401); // single use

  expect((await call('POST', '/admin/auth/login', { email, password: 'wrong-password-123' })).status).toBe(401);
  const { body } = await call('POST', '/admin/auth/login', { email, password: 'a-long-staff-password' });
  const code = (await lastMailTo(email)).match(/code is (\d{6})/)![1];
  const wrong = code === '000000' ? '111111' : '000000';
  expect((await call('POST', '/admin/auth/verify', { challengeId: body.challengeId, code: wrong })).status).toBe(401);
  const ok = await call('POST', '/admin/auth/verify', { challengeId: body.challengeId, code });
  expect(ok.status).toBe(200);
  expect((await call('POST', '/admin/auth/verify', { challengeId: body.challengeId, code })).status).toBe(401); // code used up
  return ok.body.token as string;
}


/** Multipart photo upload, like the admin page does. */
export async function upload(url: string, file: Buffer, filename: string, lastModified: Date, token: string) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file)], { type: 'image/jpeg' }), filename);
  form.append('lastModified', lastModified.toISOString());
  const res = await fetch(API + url, { method: 'POST', body: form, headers: { 'x-forwarded-for': ip, authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
}

/** A verified, signed-in parent who has redeemed the given card code. */
export async function parentWithCode(email: string, code: string) {
  await call('POST', '/auth/register', { email, password: 'correct-horse-1', firstName: 'P', lastName: 'Q' });
  await call('POST', '/auth/verify', { token: (await lastMailTo(email)).match(/token=([\w-]+)/)![1] });
  const token = (await call('POST', '/auth/login', { email, password: 'correct-horse-1' })).body.token as string;
  expect((await call('POST', '/children/redeem', { code }, token)).status).toBe(200);
  return token;
}
