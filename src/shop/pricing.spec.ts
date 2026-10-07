import { promoDiscount, type Promo } from './pricing.js';

const base: Promo = { code: 'X', percentOff: 10, amountOffPence: null, minSubtotalPence: 0, expiresAt: null, maxRedemptions: null, redemptions: 0, active: true };

describe('promoDiscount', () => {
  it('takes a percentage off, rounded to the penny', () => expect(promoDiscount(base, 2299)).toEqual({ discountPence: 230 }));
  it('never discounts more than the subtotal', () => expect(promoDiscount({ ...base, percentOff: null, amountOffPence: 5000 }, 2299)).toEqual({ discountPence: 2299 }));
  it('rejects unknown, inactive, expired, used-up and under-minimum codes', () => {
    expect(promoDiscount(null, 2299)).toHaveProperty('error');
    expect(promoDiscount({ ...base, active: false }, 2299)).toHaveProperty('error');
    expect(promoDiscount({ ...base, expiresAt: new Date(Date.now() - 1) }, 2299)).toHaveProperty('error');
    expect(promoDiscount({ ...base, maxRedemptions: 3, redemptions: 3 }, 2299)).toHaveProperty('error');
    expect(promoDiscount({ ...base, minSubtotalPence: 3000 }, 2299)).toHaveProperty('error');
  });
});

import { priceLine } from './pricing.js';
import type { Catalog } from '../catalog.js';

describe('priceLine', () => {
  const opt = (code: string, pricePence: number, extra: object = {}) => ({ code, label: code.toUpperCase(), hint: null, pricePence, digital: false, swatch: null, active: true, ...extra });
  const catalog: Catalog = {
    sizes: [opt('8x10', 2999), opt('a4', 3500, { active: false }), opt('digital', 1499, { digital: true })],
    frames: [opt('oak', 500), opt('none', 0)],
    matPricePence: 400,
    matAvailable: false,
    deliveryPence: 0,
  };
  it('adds size, frame and mount', () => expect(priceLine({ ...catalog, matAvailable: true }, '8x10', 'oak', true).unitPricePence).toBe(2999 + 500 + 400));
  it('marks switched-off sizes and mounts as unavailable', () => {
    expect(priceLine(catalog, 'a4', 'oak', false).available).toBe(false);
    expect(priceLine(catalog, '8x10', 'oak', true).available).toBe(false); // mount switched off
    expect(priceLine(catalog, '8x10', 'oak', false).available).toBe(true);
  });
  it('ignores frame and mount for digital files', () => expect(priceLine(catalog, 'digital', 'oak', true)).toMatchObject({ unitPricePence: 1499, frameCode: 'none', mat: false }));
  it('rejects unknown codes', () => expect(() => priceLine(catalog, 'huge', 'oak', false)).toThrow());
});
