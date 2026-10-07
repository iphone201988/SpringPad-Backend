import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

// What parents can buy, from the product_option table (edited in the admin). The API is the source of truth:
// basket and checkout re-price from here, never from the browser.

export type Option = { code: string; label: string; hint: string | null; pricePence: number; digital: boolean; swatch: string | null; active: boolean };
export type Catalog = { sizes: Option[]; frames: Option[]; matPricePence: number; matAvailable: boolean; deliveryPence: number };

@Injectable()
export class CatalogService {
  constructor(private readonly db: PrismaService) {}

  /** Every option, switched-off ones included (so baskets holding them can still be priced and explained). */
  async load(): Promise<Catalog> {
    const rows = await this.db.productOption.findMany({ orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] });
    const opt = (r: (typeof rows)[number]): Option => ({ code: r.code, label: r.label, hint: r.hint, pricePence: r.pricePence, digital: r.digital, swatch: r.swatch, active: r.active });
    const extra = (code: string) => rows.find((r) => r.kind === 'EXTRA' && r.code === code);
    return {
      sizes: rows.filter((r) => r.kind === 'SIZE').map(opt),
      frames: rows.filter((r) => r.kind === 'FRAME').map(opt),
      matPricePence: extra('mat')?.pricePence ?? 0,
      matAvailable: !!extra('mat')?.active,
      deliveryPence: extra('delivery')?.active ? extra('delivery')!.pricePence : 0,
    };
  }
}

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /** The shop's options: only what's switched on. */
  @Get()
  async get() {
    const c = await this.catalog.load();
    return { currency: 'GBP', ...c, sizes: c.sizes.filter((s) => s.active), frames: c.frames.filter((f) => f.active) };
  }
}

@Module({ controllers: [CatalogController], providers: [CatalogService], exports: [CatalogService] })
export class CatalogModule {}
