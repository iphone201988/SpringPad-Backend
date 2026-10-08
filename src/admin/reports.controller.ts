import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma.service.js';
import { StaffGuard } from './staff-auth.js';

const DAY = 86_400_000;

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive, UK dates); defaults to the last 30 days. Max two years. */
function range(from?: string, to?: string) {
  const ok = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  const end = ok(to) ? new Date(`${to}T00:00:00Z`) : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const start = ok(from) ? new Date(`${from}T00:00:00Z`) : new Date(end.getTime() - 29 * DAY);
  if (start > end || end.getTime() - start.getTime() > 731 * DAY) throw new BadRequestException('Choose a range of up to two years.');
  return { start, endExclusive: new Date(end.getTime() + DAY) };
}

// Money is in pence. "Net" = paid minus refunded. Sales by school/product are line totals before order-level
// discounts (an order can include siblings at different schools, so discounts aren't split per school).
// Generated products (montage etc., no photo) count in the totals and the CSV but not in the per-school table.
@Controller('admin/reports')
@UseGuards(StaffGuard)
export class ReportsController {
  constructor(private readonly db: PrismaService) {}

  @Get()
  async report(@Query('from') from?: string, @Query('to') to?: string) {
    const { start, endExclusive } = range(from, to);
    const paid = { paidAt: { gte: start, lt: endExclusive }, status: { in: ['PAID', 'REFUNDED'] as ('PAID' | 'REFUNDED')[] } };

    const [totals, daily, bySchool, byProduct, engagement] = await Promise.all([
      this.db.order.aggregate({ where: paid, _count: true, _sum: { totalPence: true, refundedPence: true, discountPence: true } }),
      this.db.$queryRaw<{ day: string; orders: number; net: number }[]>`
        SELECT to_char(date_trunc('day', paid_at AT TIME ZONE 'Europe/London'), 'YYYY-MM-DD') AS day,
               count(*)::int AS orders, sum(total_pence - refunded_pence)::int AS net
        FROM "order" WHERE status IN ('PAID','REFUNDED') AND paid_at >= ${start} AND paid_at < ${endExclusive}
        GROUP BY 1 ORDER BY 1`,
      this.db.$queryRaw<{ schoolId: string; school: string; orders: number; units: number; sales: number }[]>`
        SELECT s.id AS "schoolId", s.name AS school, count(DISTINCT o.id)::int AS orders,
               sum(l.quantity)::int AS units, sum(l.quantity * l.unit_price_pence)::int AS sales
        FROM "order" o JOIN order_line l ON l.order_id = o.id JOIN image_asset i ON i.id = l.image_id
        JOIN child c ON c.id = i.child_id JOIN school s ON s.id = c.school_id
        WHERE o.status IN ('PAID','REFUNDED') AND o.paid_at >= ${start} AND o.paid_at < ${endExclusive}
        GROUP BY s.id, s.name ORDER BY sales DESC`,
      this.db.$queryRaw<{ code: string; label: string | null; units: number; sales: number }[]>`
        SELECT l.size_code AS code, p.label, sum(l.quantity)::int AS units, sum(l.quantity * l.unit_price_pence)::int AS sales
        FROM "order" o JOIN order_line l ON l.order_id = o.id LEFT JOIN product_option p ON p.code = l.size_code
        WHERE o.status IN ('PAID','REFUNDED') AND o.paid_at >= ${start} AND o.paid_at < ${endExclusive}
        GROUP BY l.size_code, p.label ORDER BY sales DESC`,
      // Per school, all time: how many children have photos, how many have a parent linked, how many have been bought for.
      this.db.$queryRaw<{ schoolId: string; withPhotos: number; linked: number; purchased: number }[]>`
        SELECT c.school_id AS "schoolId",
               count(DISTINCT c.id) FILTER (WHERE EXISTS (SELECT 1 FROM image_asset i WHERE i.child_id = c.id AND NOT i.is_anchor))::int AS "withPhotos",
               count(DISTINCT c.id) FILTER (WHERE EXISTS (SELECT 1 FROM parent_child_link k WHERE k.child_id = c.id AND k.status = 'ACTIVE'))::int AS linked,
               count(DISTINCT c.id) FILTER (WHERE EXISTS (SELECT 1 FROM order_line l JOIN image_asset i ON i.id = l.image_id JOIN "order" o ON o.id = l.order_id
                                                         WHERE i.child_id = c.id AND o.status IN ('PAID','REFUNDED')))::int AS purchased
        FROM child c GROUP BY c.school_id`,
    ]);

    const paidPence = totals._sum.totalPence ?? 0;
    const refundedPence = totals._sum.refundedPence ?? 0;
    const eng = new Map(engagement.map((e) => [e.schoolId, e]));
    return {
      from: start.toISOString().slice(0, 10),
      to: new Date(endExclusive.getTime() - DAY).toISOString().slice(0, 10),
      totals: {
        orders: totals._count,
        paidPence,
        refundedPence,
        netPence: paidPence - refundedPence,
        discountPence: totals._sum.discountPence ?? 0,
        averageOrderPence: totals._count ? Math.round(paidPence / totals._count) : 0,
      },
      daily,
      bySchool: bySchool.map((s) => ({ ...s, ...(eng.get(s.schoolId) ?? { withPhotos: 0, linked: 0, purchased: 0 }) })),
      byProduct,
    };
  }

  /** Every paid order line in the range, for spreadsheets / accounts. */
  @Get('orders.csv')
  async csv(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @Res() res: Response) {
    const { start, endExclusive } = range(from, to);
    const rows = await this.db.$queryRaw<Record<string, string | number | Date | null>[]>`
      SELECT 'SP-' || o.number AS "order", o.paid_at AS "paid_at", o.status, o.email, s.name AS school,
             c.first_name || ' ' || c.last_name AS child, l.title AS item, l.quantity, l.unit_price_pence / 100.0 AS "unit_price_gbp",
             o.discount_pence / 100.0 AS "order_discount_gbp", o.total_pence / 100.0 AS "order_total_gbp", o.refunded_pence / 100.0 AS "order_refunded_gbp"
      FROM "order" o JOIN order_line l ON l.order_id = o.id LEFT JOIN image_asset i ON i.id = l.image_id
      LEFT JOIN child c ON c.id = i.child_id LEFT JOIN school s ON s.id = c.school_id -- generated products have no photo
      WHERE o.status IN ('PAID','REFUNDED') AND o.paid_at >= ${start} AND o.paid_at < ${endExclusive}
      ORDER BY o.paid_at, o.number`;
    const cols = ['order', 'paid_at', 'status', 'email', 'school', 'child', 'item', 'quantity', 'unit_price_gbp', 'order_discount_gbp', 'order_total_gbp', 'order_refunded_gbp'];
    const cell = (v: unknown) => {
      const t = v instanceof Date ? v.toISOString() : String(v ?? '');
      const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; // stop spreadsheets running cell text as a formula
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    res.set({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="springpad-orders-${from ?? 'last-30-days'}.csv"` });
    res.send([cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n'));
  }
}
