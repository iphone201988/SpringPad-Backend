// Brief §5 "school-verified contact push": staff email an invitation to a parent contact the school holds. Needs a running API.
import { call, lastMailTo, run, staffSession } from './helpers.js';

const signedInParent = async (email: string) => {
  await call('POST', '/auth/register', { email, password: 'correct-horse-1', firstName: 'P', lastName: 'Q' });
  await call('POST', '/auth/verify', { token: (await lastMailTo(email)).match(/token=([\w-]+)/)![1] });
  return (await call('POST', '/auth/login', { email, password: 'correct-horse-1' })).body.token as string;
};

describe('school invites', () => {
  it('links a child only for the invited email, once, and shows staff the trail', async () => {
    const staff = await staffSession('STAFF');
    const school = (await call('POST', '/admin/schools', { name: `Invite E2E ${run}` }, staff)).body.id;
    const child = (await call('POST', `/admin/schools/${school}/children`, { firstName: 'Mia', lastName: 'Ross', academicYear: '2026-27', className: 'Year 1' }, staff)).body.id;
    const email = `e2e-school-invite-${run}@example.com`;

    expect((await call('POST', `/admin/children/${child}/invites`, { email: 'not-an-email' }, staff)).status).toBe(400);
    expect((await call('POST', `/admin/children/${child}/invites`, { email })).status).toBe(401); // staff only
    expect((await call('POST', `/admin/children/${child}/invites`, { email: email.toUpperCase() }, staff)).status).toBe(201);
    const mail = await lastMailTo(email);
    expect(mail).toContain(`Invite E2E ${run} has invited you to see Mia’s school photos`);
    const token = mail.match(/guardian-invite\?token=([\w-]+)/)![1];

    const stranger = await signedInParent(`e2e-school-stranger-${run}@example.com`);
    expect((await call('POST', '/guardian-invites/accept', { token }, stranger)).status).toBe(400); // forwarded link is useless
    const parent = await signedInParent(email);
    expect((await call('POST', '/guardian-invites/accept', { token }, parent)).body.firstName).toBe('Mia');
    expect((await call('POST', '/guardian-invites/accept', { token }, parent)).status).toBe(400); // single use
    expect((await call('GET', '/children', undefined, parent)).body.map((c: { firstName: string }) => c.firstName)).toEqual(['Mia']);

    expect((await call('POST', `/admin/children/${child}/invites`, { email }, staff)).status).toBe(409); // already has access
    const view = (await call('GET', `/admin/children/${child}`, undefined, staff)).body;
    expect(view.invites).toEqual([expect.objectContaining({ email, fromSchool: true, acceptedAt: expect.any(String) })]);
    expect(view.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['SCHOOL_INVITED', 'SCHOOL_INVITE_ACCEPTED']));
  });
});
