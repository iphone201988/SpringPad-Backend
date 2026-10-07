import { Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { PrismaService } from '../prisma.service.js';
import { CurrentStaff, StaffGuard, type Staff } from './staff-auth.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const MONEY_MAX = 100_000_00; // £100,000 — a typo guard, not a business rule

class OptionCreateDto {
  @IsIn(['SIZE', 'FRAME']) kind: 'SIZE' | 'FRAME';
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)) @Matches(/^[a-z0-9][a-z0-9-]{0,29}$/) code: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(60) label: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(80) hint?: string;
  @IsInt() @Min(0) @Max(MONEY_MAX) pricePence: number;
  @IsOptional() @IsBoolean() digital?: boolean;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) swatch?: string;
}

class OptionPatchDto {
  @Transform(trim) @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) label?: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(80) hint?: string;
  @IsOptional() @IsInt() @Min(0) @Max(MONEY_MAX) pricePence?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(999) sortOrder?: number;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) swatch?: string;
}

class PromoCreateDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value)) @Matches(/^[A-Z0-9-]{3,30}$/) code: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) percentOff?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MONEY_MAX) amountOffPence?: number;
  @IsOptional() @IsInt() @Min(0) @Max(MONEY_MAX) minSubtotalPence?: number;
  @IsOptional() @IsDateString() expiresAt?: string;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
}

class PromoPatchDto {
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() expiresAt?: string | null;
}

@Controller('admin')
@UseGuards(StaffGuard)
export class CatalogAdminController {
  constructor(private readonly db: PrismaService) {}

  private audit(me: Staff, action: string, detail: object) {
    return this.db.auditLog.create({ data: { action, staffId: me.id, detail } });
  }

  // ── Products & prices ──────────────────────────────────────────────────────────────────

  @Get('catalog')
  catalog() {
    return this.db.productOption.findMany({ orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }] });
  }

  @Post('catalog')
  async createOption(@CurrentStaff() me: Staff, @Body() dto: OptionCreateDto) {
    if (await this.db.productOption.findUnique({ where: { code: dto.code } })) throw new ConflictException('That code is already used.');
    const last = await this.db.productOption.aggregate({ where: { kind: dto.kind }, _max: { sortOrder: true } });
    await this.db.productOption.create({
      data: { ...dto, digital: dto.kind === 'SIZE' && !!dto.digital, swatch: dto.kind === 'FRAME' ? (dto.swatch ?? null) : null, sortOrder: (last._max.sortOrder ?? 0) + 1 },
    });
    await this.audit(me, 'PRODUCT_CREATED', { code: dto.code, pricePence: dto.pricePence });
    return { ok: true };
  }

  /** Price changes apply to baskets straight away; orders already placed keep the price they were paid at. */
  @Patch('catalog/:code')
  async updateOption(@CurrentStaff() me: Staff, @Param('code') code: string, @Body() dto: OptionPatchDto) {
    const before = await this.db.productOption.findUnique({ where: { code } });
    if (!before) throw new NotFoundException();
    if (dto.active === false && (code === 'none' || before.kind === 'SIZE') && before.active) {
      const left = await this.db.productOption.count({ where: { kind: before.kind, active: true, code: { not: code } } });
      if (!left) throw new ConflictException('Keep at least one option of this kind switched on.');
    }
    await this.db.productOption.update({ where: { code }, data: dto });
    await this.audit(me, 'PRODUCT_UPDATED', { code, ...dto, ...(dto.pricePence !== undefined && { previousPricePence: before.pricePence }) });
    return { ok: true };
  }

  // ── Promo codes ────────────────────────────────────────────────────────────────────────

  @Get('promo-codes')
  promoCodes() {
    return this.db.promoCode.findMany({ orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] });
  }

  @Post('promo-codes')
  async createPromo(@CurrentStaff() me: Staff, @Body() dto: PromoCreateDto) {
    if (!dto.percentOff === !dto.amountOffPence) throw new ConflictException('Choose either a percentage or a fixed amount off.');
    if (await this.db.promoCode.findUnique({ where: { code: dto.code } })) throw new ConflictException('That code already exists.');
    await this.db.promoCode.create({ data: { ...dto, expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null } });
    await this.audit(me, 'PROMO_CREATED', { code: dto.code });
    return { ok: true };
  }

  @Patch('promo-codes/:code')
  async updatePromo(@CurrentStaff() me: Staff, @Param('code') code: string, @Body() dto: PromoPatchDto) {
    const p = await this.db.promoCode
      .update({ where: { code: code.toUpperCase() }, data: { ...dto, ...(dto.expiresAt !== undefined && { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null }) } })
      .catch(() => null);
    if (!p) throw new NotFoundException();
    await this.audit(me, 'PROMO_UPDATED', { code: p.code, ...dto });
    return { ok: true };
  }
}
