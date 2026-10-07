import { BadRequestException } from '@nestjs/common';
import type { Catalog } from '../catalog.js';

/**
 * The only place a price is calculated. Browser-sent prices are never used. `available` is false when the
 * size, frame or mount has since been switched off in the admin (the line can be shown but not bought).
 */
export function priceLine(catalog: Catalog, sizeCode: string, frameCode: string, mat: boolean) {
  const size = catalog.sizes.find((s) => s.code === sizeCode);
  const frame = catalog.frames.find((f) => f.code === frameCode);
  if (!size || !frame) throw new BadRequestException('Unknown size or frame.');
  if (size.digital) {
    return { unitPricePence: size.pricePence, digital: true, frameCode: 'none', mat: false, title: size.label, available: size.active };
  }
  return {
    unitPricePence: size.pricePence + frame.pricePence + (mat ? catalog.matPricePence : 0),
    digital: false,
    frameCode,
    mat,
    title: `${size.label} ${frame.code === 'none' ? 'Unframed' : frame.label} Print${mat ? ' with Mount' : ''}`,
    available: size.active && frame.active && (!mat || catalog.matAvailable),
  };
}


export type Promo = { code: string; percentOff: number | null; amountOffPence: number | null; minSubtotalPence: number; expiresAt: Date | null; maxRedemptions: number | null; redemptions: number; active: boolean };

/** Discount for a promo code against a subtotal, or the reason it can't be used. Never more than the subtotal. */
export function promoDiscount(promo: Promo | null, subtotalPence: number, now = new Date()): { discountPence: number } | { error: string } {
  if (!promo || !promo.active) return { error: 'That promo code isn’t valid.' };
  if (promo.expiresAt && promo.expiresAt <= now) return { error: 'That promo code has expired.' };
  if (promo.maxRedemptions !== null && promo.redemptions >= promo.maxRedemptions) return { error: 'That promo code has been fully used.' };
  if (subtotalPence < promo.minSubtotalPence) return { error: `That code needs a basket of at least £${(promo.minSubtotalPence / 100).toFixed(2)}.` };
  const off = promo.percentOff ? Math.round((subtotalPence * promo.percentOff) / 100) : promo.amountOffPence!;
  return { discountPence: Math.min(off, subtotalPence) };
}
