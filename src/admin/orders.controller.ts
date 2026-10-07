import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import { derivative } from '../gallery/media.js';
import { MailService } from '../mail.service.js';
import { PrismaService } from '../prisma.service.js';
import { stripe } from '../shop/payments.js';
import { CurrentStaff, StaffGuard, type Staff } from './staff-auth.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;
const FULFILMENT = ['TO_PRINT', 'PRINTING', 'DISPATCHED'] as const;

class FulfilmentDto {
  @IsIn(FULFILMENT) status: (typeof FULFILMENT)[number];
  @Transform(trim) @IsOptional() @IsString() @MaxLength(60) carrier?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(80) trackingNumber?: string;
}

class RefundDto {
  @IsInt() @Min(1) amountPence: number;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
}

class ReplyDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(5000) message: string;
  @IsOptional() @IsBoolean() resolve?: boolean;
}

class ResolveDto {
  @IsBoolean() resolved: boolean;
}

@Controller('admin')
@UseGuards(StaffGuard)
export class OrdersAdminController {
  constructor(
    private readonly db: PrismaService,
    private readonly mail: MailService,
  ) {}

  // ── Orders ─────────────────────────────────────────────────────────────────────────────

  /** Paid (and refunded) orders, newest first. q = order number ("10014" / "SP-10014") or email. */
  @Get('orders')
  async orders(@Query('fulfilment') fulfilment?: string, @Query('status') status?: string, @Query('q') q?: string) {
    const search = q?.trim().slice(0, 120);
    const number = search && /^(sp-?)?\d+$/i.test(search) ? Number(search.replace(/\D/g, '')) : null;
    const where = {
      status: status === 'REFUNDED' ? ('REFUNDED' as const) : { in: ['PAID', 'REFUNDED'] as ('PAID' | 'REFUNDED')[] },
      ...(FULFILMENT.includes(fulfilment as never) && { fulfilment: fulfilment as (typeof FULFILMENT)[number] }),
      ...(search && (number ? { number } : { email: { contains: search, mode: 'insensitive' as const } })),
    };
    const [orders, counts] = await Promise.all([
      this.db.order.findMany({
        where,
        orderBy: { paidAt: 'desc' },
        take: 200, // ponytail: no paging yet; add cursor paging past a few hundred orders a week
        select: { id: true, number: true, status: true, fulfilment: true, totalPence: true, refundedPence: true, email: true, paidAt: true, shipping: true, _count: { select: { lines: true } } },
      }),
      this.db.order.groupBy({ by: ['fulfilment'], where: { status: 'PAID' }, _count: true }),
    ]);
    return { orders, counts: Object.fromEntries(counts.map((c) => [c.fulfilment, c._count])) };
  }

  @Get('orders/:id')
  async order(@Param('id', ParseUUIDPipe) id: string) {
    const o = await this.db.order.findUnique({
      where: { id },
      include: {
        lines: { include: { image: { select: { reference: true, child: { select: { id: true, firstName: true, lastName: true, school: { select: { name: true } } } } } } } },
        refunds: { orderBy: { createdAt: 'asc' } },
        customer: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    if (!o || o.status === 'PENDING_PAYMENT') throw new NotFoundException();
    const staff = await this.db.staffUser.findMany({ where: { id: { in: o.refunds.map((r) => r.staffId) } }, select: { id: true, name: true } });
    return { ...o, refunds: o.refunds.map((r) => ({ ...r, staffName: staff.find((s) => s.id === r.staffId)?.name ?? 'Staff' })) };
  }

  /** Printing workflow. Dispatching emails the parent (with tracking when given). */
  @Post('orders/:id/fulfilment') @HttpCode(200)
  async fulfil(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FulfilmentDto) {
    const o = await this.db.order.findUnique({ where: { id } });
    if (!o || o.status !== 'PAID') throw new NotFoundException();
    if (o.fulfilment === 'NOT_REQUIRED') throw new BadRequestException('This order has no prints.');
    const dispatched = dto.status === 'DISPATCHED';
    await this.db.order.update({
      where: { id },
      data: { fulfilment: dto.status, carrier: dispatched ? (dto.carrier ?? null) : null, trackingNumber: dispatched ? (dto.trackingNumber ?? null) : null, dispatchedAt: dispatched ? new Date() : null },
    });
    await this.db.auditLog.create({ data: { action: 'ORDER_FULFILMENT', staffId: me.id, customerId: o.customerId, detail: { orderId: id, status: dto.status } } });
    if (dispatched && o.fulfilment !== 'DISPATCHED') {
      const tracking = dto.trackingNumber ? `\n\nTracking: ${[dto.carrier, dto.trackingNumber].filter(Boolean).join(' ')}` : '';
      await this.mail.send(o.email, `Your Springpad order #SP-${o.number} is on its way`, `Good news — your prints have been posted.${tracking}\n\nView your order: ${process.env.STOREFRONT_URL}/account/orders/${o.id}`);
    }
    return { ok: true };
  }

  /**
   * Full or partial refund. Real money goes back through Stripe (refunding the order's payment); in simulated
   * dev mode it's only recorded. A full refund also removes the digital download rights.
   * ponytail: refunds made directly in the Stripe dashboard aren't synced back; add a charge.refunded webhook if staff do that.
   */
  @Post('orders/:id/refund') @HttpCode(200)
  async refund(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundDto) {
    const o = await this.db.order.findUnique({ where: { id } });
    if (!o || o.status !== 'PAID') throw new ConflictException('Only paid orders can be refunded.');
    const left = o.totalPence - o.refundedPence;
    if (dto.amountPence > left) throw new BadRequestException(`At most ${gbp(left)} can still be refunded.`);

    let stripeRefundId: string | null = null;
    if (o.stripeSessionId && stripe) {
      const session = await stripe.checkout.sessions.retrieve(o.stripeSessionId);
      const pi = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      if (!pi) throw new ConflictException('Stripe has no payment for this order.');
      const r = await stripe.refunds.create({ payment_intent: pi, amount: dto.amountPence, metadata: { orderId: o.id, staffId: me.id } }, { idempotencyKey: `refund-${o.id}-${o.refundedPence}-${dto.amountPence}` });
      stripeRefundId = r.id;
    }
    const full = dto.amountPence === left;
    await this.db.$transaction([
      this.db.orderRefund.create({ data: { orderId: id, amountPence: dto.amountPence, reason: dto.reason, staffId: me.id, stripeRefundId } }),
      this.db.order.update({ where: { id }, data: { refundedPence: { increment: dto.amountPence }, ...(full && { status: 'REFUNDED' }) } }),
      ...(full ? [this.db.entitlement.deleteMany({ where: { orderLine: { orderId: id } } })] : []),
      this.db.auditLog.create({ data: { action: 'ORDER_REFUNDED', staffId: me.id, customerId: o.customerId, detail: { orderId: id, amountPence: dto.amountPence, full } } }),
    ]);
    await this.mail.send(o.email, `Refund for your Springpad order #SP-${o.number}`, `We’ve refunded ${gbp(dto.amountPence)} to your original payment method. It can take 5–10 working days to appear.\n\nReason: ${dto.reason}`);
    return { ok: true, full };
  }

  /** Small preview of a published photo for order screens (staff only). */
  @Get('images/:id/thumb') @SkipThrottle()
  async imageThumb(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const img = await this.db.imageAsset.findUnique({ where: { id }, select: { masterKey: true } });
    if (!img) throw new NotFoundException();
    res.set({ 'content-type': 'image/webp', 'cache-control': 'private, max-age=3600' }).send(await derivative(id, img.masterKey, 'thumb'));
  }

  // ── Support inbox ──────────────────────────────────────────────────────────────────────

  @Get('support')
  async support(@Query('resolved') resolved?: string) {
    const [requests, open] = await Promise.all([
      this.db.supportRequest.findMany({
        where: { resolved: resolved === 'true' },
        orderBy: { createdAt: resolved === 'true' ? 'desc' : 'asc' }, // open: oldest first, so nothing waits forever
        take: 200,
        select: { id: true, number: true, name: true, email: true, subject: true, message: true, createdAt: true, resolved: true, _count: { select: { replies: true } } },
      }),
      this.db.supportRequest.count({ where: { resolved: false } }),
    ]);
    return { requests, open };
  }

  @Get('support/:id')
  async supportRequest(@Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.supportRequest.findUnique({ where: { id }, include: { replies: { orderBy: { createdAt: 'asc' } } } });
    if (!r) throw new NotFoundException();
    const staff = await this.db.staffUser.findMany({ where: { id: { in: r.replies.map((x) => x.staffId) } }, select: { id: true, name: true } });
    // Their orders, so staff can answer "where's my order?" without searching.
    const orders = await this.db.order.findMany({ where: { email: r.email, status: { in: ['PAID', 'REFUNDED'] } }, orderBy: { paidAt: 'desc' }, take: 5, select: { id: true, number: true, status: true, fulfilment: true, totalPence: true, paidAt: true } });
    return { ...r, replies: r.replies.map((x) => ({ ...x, staffName: staff.find((s) => s.id === x.staffId)?.name ?? 'Staff' })), orders };
  }

  @Post('support/:id/reply') @HttpCode(200)
  async reply(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplyDto) {
    const r = await this.db.supportRequest.findUnique({ where: { id } });
    if (!r) throw new NotFoundException();
    await this.mail.send(r.email, `Re: ${r.subject} [Springpad #${r.number}]`, `Hi ${r.name},\n\n${dto.message}\n\n— ${me.name}, Springpad support\n\n> ${r.message.split('\n').join('\n> ')}`);
    await this.db.$transaction([
      this.db.supportReply.create({ data: { requestId: id, staffId: me.id, body: dto.message } }),
      ...(dto.resolve ? [this.db.supportRequest.update({ where: { id }, data: { resolved: true } })] : []),
    ]);
    return { ok: true };
  }

  @Post('support/:id/resolve') @HttpCode(200)
  async resolve(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveDto) {
    const r = await this.db.supportRequest.update({ where: { id }, data: { resolved: dto.resolved } }).catch(() => null);
    if (!r) throw new NotFoundException();
    return { ok: true };
  }
}
