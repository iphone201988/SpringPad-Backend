// Admin orders + support inbox. Orders are inserted directly (paid, no Stripe session), so refunds are recorded
// without moving real money; the Stripe refund path is checked by hand in test mode.
import 'dotenv/config';
import pg from 'pg';
import { call, lastMailTo, run, staffSession } from './helpers.js';

describe('admin orders & support', () => {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  let staff = '';
  let orderId = '';
  const email = `e2e-order-${run}@example.com`;

  beforeAll(async () => {
    staff = await staffSession('STAFF');
    await db.connect();
    const img = (await db.query(`SELECT id, child_id FROM image_asset WHERE NOT is_anchor LIMIT 1`)).rows[0];
    const cust = (await db.query(`INSERT INTO customer (id, email, password_hash, first_name, last_name, verified_at, updated_at) VALUES (gen_random_uuid(), $1, 'x', 'Ord', 'Er', now(), now()) RETURNING id`, [email])).rows[0];
    orderId = (
      await db.query(
        `INSERT INTO "order" (id, customer_id, status, subtotal_pence, delivery_pence, total_pence, email, shipping, paid_at, fulfilment)
         VALUES (gen_random_uuid(), $1, 'PAID', 3000, 0, 3000, $2, '{"name":"Ord Er","address":"1 Test St"}', now(), 'TO_PRINT') RETURNING id`,
        [cust.id, email],
      )
    ).rows[0].id;
    const print = (await db.query(`INSERT INTO order_line (id, order_id, image_id, title, size_code, frame_code, mat, digital, quantity, unit_price_pence) VALUES (gen_random_uuid(), $1, $2, '5 × 7 Print', '5x7', 'none', false, false, 1, 1500) RETURNING id`, [orderId, img.id])).rows[0];
    const digital = (await db.query(`INSERT INTO order_line (id, order_id, image_id, title, size_code, frame_code, mat, digital, quantity, unit_price_pence) VALUES (gen_random_uuid(), $1, $2, 'Digital', 'digital', 'none', false, true, 1, 1500) RETURNING id`, [orderId, img.id])).rows[0];
    void print;
    await db.query(`INSERT INTO entitlement (id, customer_id, order_line_id, image_id) VALUES (gen_random_uuid(), $1, $2, $3)`, [cust.id, digital.id, img.id]);
  });
  afterAll(() => db.end());

  it('moves an order through printing to dispatch and tells the parent', async () => {
    const number = (await call('GET', `/admin/orders/${orderId}`, undefined, staff)).body.number;
    expect((await call('GET', `/admin/orders?q=SP-${number}`, undefined, staff)).body.orders.map((o: { id: string }) => o.id)).toEqual([orderId]);
    expect((await call('POST', `/admin/orders/${orderId}/fulfilment`, { status: 'PRINTING' }, staff)).status).toBe(200);
    expect((await call('POST', `/admin/orders/${orderId}/fulfilment`, { status: 'DISPATCHED', carrier: 'Royal Mail', trackingNumber: 'AB123456789GB' }, staff)).status).toBe(200);
    expect(await lastMailTo(email)).toContain('AB123456789GB');
  });

  it('refunds partly, then fully — and a full refund removes download rights', async () => {
    expect((await call('POST', `/admin/orders/${orderId}/refund`, { amountPence: 5000, reason: 'too much' }, staff)).status).toBe(400);
    expect((await call('POST', `/admin/orders/${orderId}/refund`, { amountPence: 1000, reason: 'Frame damaged' }, staff)).body).toEqual({ ok: true, full: false });
    expect((await call('POST', `/admin/orders/${orderId}/refund`, { amountPence: 2000, reason: 'Customer cancelled' }, staff)).body).toEqual({ ok: true, full: true });
    const o = (await call('GET', `/admin/orders/${orderId}`, undefined, staff)).body;
    expect([o.status, o.refundedPence, o.refunds.length]).toEqual(['REFUNDED', 3000, 2]);
    expect((await db.query(`SELECT 1 FROM entitlement e JOIN order_line l ON l.id = e.order_line_id WHERE l.order_id = $1`, [orderId])).rowCount).toBe(0);
    expect((await call('POST', `/admin/orders/${orderId}/refund`, { amountPence: 1, reason: 'again' }, staff)).status).toBe(409);
  });

  it('lets staff reply to a contact-form message and resolve it', async () => {
    await call('POST', '/support', { name: 'Pat', email: `e2e-support-${run}@example.com`, subject: 'General Question', message: 'Hello?' });
    const req = (await call('GET', '/admin/support', undefined, staff)).body.requests.find((r: { email: string }) => r.email === `e2e-support-${run}@example.com`);
    expect((await call('POST', `/admin/support/${req.id}/reply`, { message: 'Hi Pat, here to help.', resolve: true }, staff)).status).toBe(200);
    expect(await lastMailTo(`e2e-support-${run}@example.com`)).toContain('here to help');
    const after = (await call('GET', `/admin/support/${req.id}`, undefined, staff)).body;
    expect([after.resolved, after.replies.length]).toEqual([true, 1]);
  });
});
