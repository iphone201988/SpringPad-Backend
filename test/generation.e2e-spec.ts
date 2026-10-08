// Brief "architect now" hooks: a generated product (e.g. the growth montage) can be ordered and paid for before it
// exists, and any AI provider plugs in through GenerationProvider. Talks to the database directly (no API needed).
import 'dotenv/config';
import { CatalogService } from '../src/catalog.js';
import { runJob, type GenerationProvider } from '../src/generation/generation.js';
import { MailService } from '../src/mail.service.js';
import { PrismaService } from '../src/prisma.service.js';
import { ShopService } from '../src/shop/shop.service.js';
import { run } from './helpers.js';

describe('generated products', () => {
  const db = new PrismaService();
  const shop = new ShopService(db, new MailService(), new CatalogService(db));
  afterAll(() => db.$disconnect());

  async function family() {
    const email = `e2e-gen-${run}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const customer = await db.customer.create({ data: { email, passwordHash: 'x', firstName: 'G', lastName: 'H', verifiedAt: new Date() } });
    const school = await db.school.create({ data: { name: `Gen E2E ${run}` } });
    const child = await db.child.create({ data: { schoolId: school.id, firstName: 'Ella', lastName: 'H' } });
    const link = await db.parentChildLink.create({ data: { customerId: customer.id, childId: child.id } });
    const photo = (ref: string) => db.imageAsset.create({ data: { childId: child.id, reference: ref, masterKey: `e2e/${ref}.jpg`, width: 10, height: 10 } });
    return { customer, link, photos: [await photo('reception'), await photo('year-6')] };
  }

  // Stands in for a real provider (e.g. a FILM/RIFE worker); records what it was asked to make.
  const fake = { name: 'fake', calls: [] as string[][], async generate(job: { inputKeys: string[] }) { this.calls.push(job.inputKeys); return { resultKey: 'generated/x.mp4', previewKey: 'generated/x-preview.mp4' }; } } satisfies GenerationProvider & { calls: string[][] };

  it('sells a montage before it exists, then makes it through a provider', async () => {
    const { customer, photos } = await family();
    const job = await db.generationJob.create({ data: { customerId: customer.id, kind: 'MONTAGE', provider: 'fake', inputImageIds: photos.map((p) => p.id) } });
    const order = await db.order.create({
      data: {
        customerId: customer.id, email: customer.email, shipping: {}, subtotalPence: 1999, deliveryPence: 0, totalPence: 1999,
        lines: { create: { jobId: job.id, title: 'Growth montage', sizeCode: 'montage', frameCode: 'none', mat: false, digital: true, quantity: 1, unitPricePence: 1999 } },
      },
    });

    await shop.markPaid(order.id);
    const [ent] = await db.entitlement.findMany({ where: { customerId: customer.id } });
    expect(ent).toMatchObject({ jobId: job.id, imageId: null }); // paid for and entitled…
    expect((await db.generationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('QUEUED'); // …before it exists
    expect(await shop.downloads(customer.id)).toEqual([]); // not offered as a photo download

    await runJob(db, [fake], job.id);
    await runJob(db, [fake], job.id); // second call is a no-op
    expect(fake.calls).toEqual([['e2e/reception.jpg', 'e2e/year-6.jpg']]); // masters, in the chosen order
    expect(await db.generationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'DONE', resultKey: 'generated/x.mp4', previewKey: 'generated/x-preview.mp4' });
  });

  it('fails a job whose photos the parent can no longer see, or whose provider is unknown', async () => {
    const { customer, link, photos } = await family();
    const unknown = await db.generationJob.create({ data: { customerId: customer.id, kind: 'MONTAGE', provider: 'nope', inputImageIds: [photos[0].id] } });
    await runJob(db, [fake], unknown.id);
    expect(await db.generationJob.findUniqueOrThrow({ where: { id: unknown.id } })).toMatchObject({ status: 'FAILED', error: 'No provider called "nope"' });

    const revoked = await db.generationJob.create({ data: { customerId: customer.id, kind: 'MONTAGE', provider: 'fake', inputImageIds: [photos[0].id] } });
    await db.parentChildLink.update({ where: { id: link.id }, data: { status: 'REVOKED' } });
    await runJob(db, [fake], revoked.id);
    expect((await db.generationJob.findUniqueOrThrow({ where: { id: revoked.id } })).status).toBe('FAILED');
  });

  it('lets the database refuse a line or entitlement that is both or neither a photo and a generated product', async () => {
    const { customer, photos } = await family();
    const job = await db.generationJob.create({ data: { customerId: customer.id, kind: 'MONTAGE', provider: 'fake', inputImageIds: [] } });
    const order = await db.order.create({ data: { customerId: customer.id, email: customer.email, shipping: {}, subtotalPence: 0, deliveryPence: 0, totalPence: 0 } });
    const line = { orderId: order.id, title: 't', sizeCode: 'digital', frameCode: 'none', mat: false, digital: true, quantity: 1, unitPricePence: 0 };
    await expect(db.orderLine.create({ data: { ...line, imageId: photos[0].id, jobId: job.id } })).rejects.toThrow(/order_line_one_product/);
    await expect(db.orderLine.create({ data: line })).rejects.toThrow(/order_line_one_product/);
    const ok = await db.orderLine.create({ data: { ...line, imageId: photos[0].id } });
    await expect(db.entitlement.create({ data: { customerId: customer.id, orderLineId: ok.id } })).rejects.toThrow(/entitlement_one_product/);
  });
});
