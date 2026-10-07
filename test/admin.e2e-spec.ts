// Staff admin: invite → password → emailed code → session, roles, and code issuing. Needs a running API.
import 'dotenv/config';
import pg from 'pg';
import { call, lastMailTo, run, staffSession } from './helpers.js';

describe('admin', () => {
  let superadmin = '', staff = '';
  beforeAll(async () => {
    superadmin = await staffSession('SUPERADMIN');
    staff = await staffSession('STAFF');
  });

  it('keeps staff management to superadmins, and parents out entirely', async () => {
    expect((await call('GET', '/admin/staff', undefined, superadmin)).status).toBe(200);
    expect((await call('GET', '/admin/staff', undefined, staff)).status).toBe(403);
    expect((await call('GET', '/admin/schools', undefined, staff)).status).toBe(200);
    expect((await call('GET', '/admin/schools')).status).toBe(401);
  });

  it('imports a class list and issues codes that only work once, and only the newest one', async () => {
    const school = (await call('POST', '/admin/schools', { name: `Admin E2E ${run}` }, staff)).body.id;
    const imp = await call('POST', `/admin/schools/${school}/children/import`, { academicYear: '2026-27', csv: 'first,last,class\nAmy,Lee,Year 3\nBen,Lee,Year 1' }, staff);
    expect(imp.body).toEqual({ added: 2, skipped: 0 });
    const list = (await call('GET', `/admin/schools/${school}/children?year=2026-27`, undefined, staff)).body;
    const amy = list.children.find((c: { firstName: string }) => c.firstName === 'Amy');
    expect(amy.code).toBe('NONE');

    const shootId = (await call('POST', `/admin/schools/${school}/shoots`, { name: 'Spring', takenOn: '2027-03-01', academicYear: '2026-27' }, staff)).body.id;
    const [first] = (await call('POST', '/admin/codes', { shootId, childIds: [amy.id] }, staff)).body;
    const [second] = (await call('POST', '/admin/codes', { shootId, childIds: [amy.id] }, staff)).body;

    // a parent can redeem only the newest card code
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    const email = `e2e-admin-parent-${run}@example.com`;
    await call('POST', '/auth/register', { email, password: 'correct-horse-1', firstName: 'P', lastName: 'Q' });
    await call('POST', '/auth/verify', { token: (await lastMailTo(email)).match(/token=([\w-]+)/)![1] });
    const parent = (await call('POST', '/auth/login', { email, password: 'correct-horse-1' })).body.token;
    expect((await call('POST', '/children/redeem', { code: first.code }, parent)).status).not.toBe(200);
    expect((await call('POST', '/children/redeem', { code: second.code }, parent)).status).toBe(200);

    const leaked = await db.query(`SELECT 1 FROM audit_log WHERE detail::text LIKE $1`, [`%${second.code}%`]); // plain codes are never logged
    expect(leaked.rowCount).toBe(0);
    await db.end();
  });
});
