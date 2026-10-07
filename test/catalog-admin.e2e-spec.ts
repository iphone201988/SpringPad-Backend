// Products & prices and promo codes from the admin, reflected in the public catalogue.
import { call, run, staffSession } from './helpers.js';

describe('catalog admin', () => {
  it('changes a price, switches an option off and on, and adds a frame', async () => {
    const staff = await staffSession('STAFF');
    const before = (await call('GET', '/catalog')).body.sizes.find((s: { code: string }) => s.code === '8x10').pricePence;
    try {
      await call('PATCH', '/admin/catalog/8x10', { pricePence: before + 100 }, staff);
      expect((await call('GET', '/catalog')).body.sizes.find((s: { code: string }) => s.code === '8x10').pricePence).toBe(before + 100);
      await call('PATCH', '/admin/catalog/8x10', { active: false }, staff);
      expect((await call('GET', '/catalog')).body.sizes.map((s: { code: string }) => s.code)).not.toContain('8x10');
    } finally {
      await call('PATCH', '/admin/catalog/8x10', { pricePence: before, active: true }, staff);
    }
    const code = `e2e-${run}`.slice(0, 30);
    expect((await call('POST', '/admin/catalog', { kind: 'FRAME', code, label: 'Test Walnut', pricePence: 700, swatch: '#5a3a22' }, staff)).status).toBe(201);
    expect((await call('GET', '/catalog')).body.frames.find((f: { code: string }) => f.code === code)).toMatchObject({ label: 'Test Walnut', swatch: '#5a3a22' });
    await call('PATCH', `/admin/catalog/${code}`, { active: false }, staff); // tidy: leave it switched off
  });

  it('creates promo codes and ends them', async () => {
    const staff = await staffSession('STAFF');
    const code = `E2E${run}`.slice(0, 20);
    expect((await call('POST', '/admin/promo-codes', { code, percentOff: 10, amountOffPence: 100 }, staff)).status).toBe(409); // one kind only
    expect((await call('POST', '/admin/promo-codes', { code: code.toLowerCase(), percentOff: 15 }, staff)).status).toBe(201);
    expect((await call('GET', '/admin/promo-codes', undefined, staff)).body.find((p: { code: string }) => p.code === code)).toMatchObject({ percentOff: 15, active: true });
    await call('PATCH', `/admin/promo-codes/${code}`, { active: false }, staff);
    expect((await call('GET', '/admin/promo-codes', undefined, staff)).body.find((p: { code: string }) => p.code === code).active).toBe(false);
  });
});
