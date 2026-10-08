import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import path from 'node:path';
import { signedUrl } from '../gallery/media.js';
import { MailService } from '../mail.service.js';
import { PrismaService } from '../prisma.service.js';
import { createAddCardSession, createCheckoutSession, stripe } from './payments.js';
import { CatalogService } from '../catalog.js';
import { priceLine, promoDiscount } from './pricing.js';

// Same rule as the gallery: only images of children this parent is actively linked to.
const linkedImage = (customerId: string) => ({ isAnchor: false, child: { links: { some: { customerId, status: 'ACTIVE' as const } } } });

export type BasketInput = { imageId: string; sizeCode: string; frameCode: string; mat: boolean; quantity: number };
export type ShippingInput = { name: string; email: string; address: string };

@Injectable()
export class ShopService {
  constructor(
    private readonly db: PrismaService,
    private readonly mail: MailService,
    private readonly catalog: CatalogService,
  ) {}

  // ── Basket ──────────────────────────────────────────────────────────────────────────────

  /** Priced basket. With a promo code, also the discount — or a 400 saying why the code can't be used. */
  async basket(customerId: string, promoCode?: string) {
    const lines = await this.db.basketLine.findMany({
      where: { customerId, image: linkedImage(customerId) }, // lines for revoked children silently drop out
      orderBy: { createdAt: 'asc' },
      include: { image: { select: { id: true, reference: true, child: { select: { firstName: true, lastName: true } } } } },
    });
    const catalog = await this.catalog.load();
    const priced = lines.map((l) => {
      const p = priceLine(catalog, l.sizeCode, l.frameCode, l.mat);
      return {
        id: l.id,
        imageId: l.imageId,
        title: p.title,
        subtitle: `${l.image.child.firstName} ${l.image.child.lastName} · #${l.image.reference}`,
        quantity: l.quantity,
        unitPricePence: p.unitPricePence,
        linePricePence: p.unitPricePence * l.quantity,
        digital: p.digital,
        available: p.available, // false: switched off in the admin since it was added
        thumbUrl: signedUrl(l.imageId, 'thumb'),
      };
    });
    const subtotalPence = priced.reduce((s, l) => s + l.linePricePence, 0);
    const deliveryPence = priced.some((l) => !l.digital) ? catalog.deliveryPence : 0;
    let discountPence = 0;
    const code = promoCode?.trim().toUpperCase() || null;
    if (code) {
      const r = promoDiscount(await this.db.promoCode.findUnique({ where: { code } }), subtotalPence);
      if ('error' in r) throw new BadRequestException(r.error);
      discountPence = r.discountPence;
    }
    return { lines: priced, subtotalPence, deliveryPence, discountPence, promoCode: code, totalPence: subtotalPence - discountPence + deliveryPence };
  }

  async addToBasket(customerId: string, input: BasketInput) {
    const image = await this.db.imageAsset.findFirst({ where: { id: input.imageId, ...linkedImage(customerId) }, select: { id: true } });
    if (!image) throw new NotFoundException();
    const p = priceLine(await this.catalog.load(), input.sizeCode, input.frameCode, input.mat); // validates codes, normalises digital lines
    if (!p.available) throw new BadRequestException('That option is no longer available.');
    await this.db.basketLine.create({
      data: { customerId, imageId: image.id, sizeCode: input.sizeCode, frameCode: p.frameCode, mat: p.mat, quantity: input.quantity },
    });
    return this.basket(customerId);
  }

  async removeFromBasket(customerId: string, lineId: string) {
    await this.db.basketLine.deleteMany({ where: { id: lineId, customerId } });
    return this.basket(customerId);
  }

  // ── Checkout & orders ───────────────────────────────────────────────────────────────────

  /** Freezes the basket into an order (re-priced on the server), then hands off to payment. */
  async checkout(customerId: string, shipping: ShippingInput, promoCode?: string) {
    const basket = await this.basket(customerId, promoCode);
    if (!basket.lines.length) throw new BadRequestException('Your basket is empty.');
    const gone = basket.lines.find((l) => !l.available);
    if (gone) throw new BadRequestException(`“${gone.title}” is no longer available. Please remove it from your basket.`);
    if (stripe && basket.totalPence > 0 && basket.totalPence < 30) throw new BadRequestException('Card payments must be at least £0.30.'); // Stripe's minimum charge
    const raw = await this.db.basketLine.findMany({ where: { id: { in: basket.lines.map((l) => l.id) } } });
    const catalog = await this.catalog.load();

    const order = await this.db.$transaction(async (tx) => {
      const o = await tx.order.create({
        data: {
          customerId,
          email: shipping.email,
          shipping: { name: shipping.name, address: shipping.address },
          subtotalPence: basket.subtotalPence,
          deliveryPence: basket.deliveryPence,
          discountPence: basket.discountPence,
          promoCode: basket.promoCode,
          totalPence: basket.totalPence,
          lines: {
            create: raw.map((l) => {
              const p = priceLine(catalog, l.sizeCode, l.frameCode, l.mat);
              return { imageId: l.imageId, title: p.title, sizeCode: l.sizeCode, frameCode: p.frameCode, mat: p.mat, digital: p.digital, quantity: l.quantity, unitPricePence: p.unitPricePence };
            }),
          },
        },
        include: { lines: true },
      });
      await tx.basketLine.deleteMany({ where: { customerId } });
      return o;
    });

    // Fully discounted orders need no payment. Simulated payment is dev only (payments.ts refuses it in production).
    if (!stripe || order.totalPence === 0) {
      await this.markPaid(order.id); // simulated payment (dev only — payments.ts refuses this in production)
      return { orderId: order.id, url: `${process.env.STOREFRONT_URL}/checkout/success?order=${order.id}` };
    }
    const session = await createCheckoutSession({ stripeCustomerId: await this.stripeCustomer(customerId), orderId: order.id, orderNumber: order.number, email: order.email, lines: order.lines, deliveryPence: order.deliveryPence, discountPence: order.discountPence, promoCode: order.promoCode });
    await this.db.order.update({ where: { id: order.id }, data: { stripeSessionId: session.sessionId } });
    return { orderId: order.id, url: session.url };
  }

  /** Idempotent: Stripe may deliver the same webhook more than once. */
  async markPaid(orderId: string) {
    const claimed = await this.db.order.updateManyAndReturn({ where: { id: orderId, status: 'PENDING_PAYMENT' }, data: { status: 'PAID', paidAt: new Date() } });
    if (!claimed.length) return;
    const o = claimed[0];
    if (o.promoCode) await this.db.promoCode.update({ where: { code: o.promoCode }, data: { redemptions: { increment: 1 } } });
    const lines = await this.db.orderLine.findMany({ where: { orderId } });
    if (lines.some((l) => !l.digital)) await this.db.order.update({ where: { id: orderId }, data: { fulfilment: 'TO_PRINT' } });
    await this.db.entitlement.createMany({
      // a generated product's line carries jobId: entitled now, downloadable once the job is DONE
      data: lines.filter((l) => l.digital).map((l) => ({ customerId: o.customerId, orderLineId: l.id, imageId: l.imageId, jobId: l.jobId })),
      skipDuplicates: true,
    });
    const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;
    await this.mail.send(
      o.email,
      `Your Springpad order #SP-${o.number}`,
      `Thank you for your order.\n\n${lines.map((l) => `${l.title} × ${l.quantity}  ${gbp(l.unitPricePence * l.quantity)}`).join('\n')}${o.discountPence ? `\nDiscount (${o.promoCode})  -${gbp(o.discountPence)}` : ''}\n\nTotal paid: ${gbp(o.totalPence)}\n\nView it any time: ${process.env.STOREFRONT_URL}/account/orders/${o.id}${lines.some((l) => l.digital) ? '\nYour digital files are ready under Account → Downloads.' : ''}`,
    );
  }

  orders(customerId: string, status?: 'PAID' | 'CANCELLED' | 'REFUNDED') {
    return this.db.order.findMany({
      where: { customerId, status: status ?? { not: 'PENDING_PAYMENT' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, number: true, status: true, fulfilment: true, totalPence: true, createdAt: true, _count: { select: { lines: true } } },
    });
  }

  async order(customerId: string, orderId: string) {
    const order = await this.db.order.findFirst({ where: { id: orderId, customerId }, include: { lines: true } });
    if (!order) throw new NotFoundException();
    return order;
  }

  // ── Saved cards (Stripe) ──────────────────────────────────────────────────────────────────

  /** The parent's Stripe customer, created on first use. Every card call is scoped to it. */
  private async stripeCustomer(customerId: string) {
    const c = await this.db.customer.findUniqueOrThrow({ where: { id: customerId } });
    if (c.stripeCustomerId) return c.stripeCustomerId;
    const sc = await stripe!.customers.create({ email: c.email, name: `${c.firstName} ${c.lastName}`, metadata: { springpadCustomerId: c.id } });
    await this.db.customer.update({ where: { id: customerId }, data: { stripeCustomerId: sc.id } });
    return sc.id;
  }

  async paymentMethods(customerId: string) {
    if (!stripe) return { available: false, methods: [] };
    const c = await this.db.customer.findUniqueOrThrow({ where: { id: customerId } });
    if (!c.stripeCustomerId) return { available: true, methods: [] };
    const list = await stripe.paymentMethods.list({ customer: c.stripeCustomerId, type: 'card' });
    return {
      available: true,
      methods: list.data.map((pm) => ({ id: pm.id, brand: pm.card?.brand ?? 'card', last4: pm.card?.last4 ?? '', expMonth: pm.card?.exp_month, expYear: pm.card?.exp_year })),
    };
  }

  async addPaymentMethod(customerId: string) {
    if (!stripe) throw new BadRequestException('Card payments are not connected yet.');
    return { url: await createAddCardSession(await this.stripeCustomer(customerId)) };
  }

  async removePaymentMethod(customerId: string, paymentMethodId: string) {
    if (!stripe) throw new NotFoundException();
    const c = await this.db.customer.findUniqueOrThrow({ where: { id: customerId } });
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId).catch(() => null);
    if (!pm || !c.stripeCustomerId || pm.customer !== c.stripeCustomerId) throw new NotFoundException(); // only your own cards
    await stripe.paymentMethods.detach(paymentMethodId);
  }

  /** Purchased digital files, with a short-lived link to the full-resolution original. */
  async downloads(customerId: string) {
    const items = await this.db.entitlement.findMany({
      where: { customerId },
      orderBy: { grantedAt: 'desc' },
      include: { orderLine: { select: { order: { select: { number: true } } } } },
    });
    // ponytail: generated products (jobId) aren't listed yet; add them with the montage UI and a result-file route
    const images = await this.db.imageAsset.findMany({
      where: { id: { in: items.flatMap((e) => (e.imageId ? [e.imageId] : [])) } },
      select: { id: true, reference: true, width: true, height: true, masterKey: true, child: { select: { firstName: true } } },
    });
    return items.flatMap((e) => {
      const img = images.find((i) => i.id === e.imageId);
      return img
        ? [{ id: e.id, name: `${img.child.firstName} Portrait #${img.reference}${path.extname(img.masterKey).toLowerCase()}`, meta: `${img.width} × ${img.height} px • Print Ready`, orderNumber: e.orderLine.order.number, url: signedUrl(img.id, 'original') }]
        : [];
    });
  }
}
