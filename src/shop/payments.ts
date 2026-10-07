import { Logger } from '@nestjs/common';
import Stripe from 'stripe';

// Stripe when STRIPE_SECRET_KEY is set; otherwise a simulated "paid instantly" mode for local development.
// The simulated mode refuses to run in production so it can never take orders without payment.
export const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

if (!stripe) {
  if (process.env.NODE_ENV === 'production') throw new Error('STRIPE_SECRET_KEY is required in production');
  new Logger('Payments').warn('STRIPE_SECRET_KEY not set — using simulated payments (dev only).');
}

type CheckoutInput = {
  stripeCustomerId: string;
  orderId: string;
  orderNumber: number;
  email: string;
  lines: { title: string; unitPricePence: number; quantity: number }[];
  deliveryPence: number;
  discountPence: number;
  promoCode: string | null;
};

/** Creates a Stripe Checkout Session (card, Apple Pay, Google Pay are shown automatically when enabled). */
export async function createCheckoutSession(o: CheckoutInput) {
  const site = process.env.STOREFRONT_URL;
  // Our server already decided the discount; a single-use coupon just tells Stripe the amount.
  const coupon = o.discountPence
    ? await stripe!.coupons.create({ amount_off: o.discountPence, currency: 'gbp', duration: 'once', max_redemptions: 1, name: `Promo ${o.promoCode}` })
    : null;
  const session = await stripe!.checkout.sessions.create({
    mode: 'payment',
    ...(coupon && { discounts: [{ coupon: coupon.id }] }),
    customer: o.stripeCustomerId,
    // shows an opt-in "save card for next time" checkbox; saved cards attach to this parent's Stripe customer
    saved_payment_method_options: { payment_method_save: 'enabled' },
    client_reference_id: o.orderId,
    metadata: { orderId: o.orderId },
    line_items: [
      ...o.lines.map((l) => ({
        quantity: l.quantity,
        price_data: { currency: 'gbp', unit_amount: l.unitPricePence, product_data: { name: l.title } },
      })),
      ...(o.deliveryPence ? [{ quantity: 1, price_data: { currency: 'gbp', unit_amount: o.deliveryPence, product_data: { name: 'Delivery' } } }] : []),
    ],
    success_url: `${site}/checkout/success?order=${o.orderId}`,
    cancel_url: `${site}/memories?checkout=cancelled`,
  });
  return { sessionId: session.id, url: session.url! };
}

/** Stripe-hosted page to add a card (setup mode): card details never touch our servers. */
export async function createAddCardSession(stripeCustomerId: string) {
  const site = process.env.STOREFRONT_URL;
  const session = await stripe!.checkout.sessions.create({
    mode: 'setup',
    currency: 'gbp',
    customer: stripeCustomerId,
    success_url: `${site}/account/payment-methods?added=1`,
    cancel_url: `${site}/account/payment-methods`,
  });
  return session.url!;
}
