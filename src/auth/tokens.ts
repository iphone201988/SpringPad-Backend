import { createHmac, randomBytes } from 'node:crypto';

// 256-bit random token for the user; only its HMAC is stored in the database.
export const newToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token: string) =>
  createHmac('sha256', process.env.TOKEN_PEPPER ?? '').update(token).digest('hex');

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
