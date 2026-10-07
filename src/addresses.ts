import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AuthGuard, CurrentCustomer, type AuthedCustomer } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { PrismaService } from './prisma.service.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const MAX_ADDRESSES = 10;

class AddressDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(120) line1: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) line2?: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(80) city: string;
  // UK postcode, loosely (spaces optional, any case)
  // normalised to the standard "GW1 2AB" form: the inward code is always the last 3 characters
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase().replace(/\s+/g, '').replace(/^(.+)(.{3})$/, '$1 $2') : value))
  @Matches(/^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/, { message: 'Enter a valid UK postcode.' })
  postcode: string;
  @IsOptional() @IsBoolean() isDefaultShipping?: boolean;
  @IsOptional() @IsBoolean() isDefaultBilling?: boolean;
}

@Injectable()
class AddressService {
  constructor(private readonly db: PrismaService) {}

  list(customerId: string) {
    return this.db.address.findMany({ where: { customerId }, orderBy: [{ isDefaultShipping: 'desc' }, { createdAt: 'asc' }] });
  }

  /** Keeps at most one default of each kind per customer. The first address becomes both defaults. */
  private async save(customerId: string, dto: AddressDto, id?: string) {
    const isFirst = !id && (await this.db.address.count({ where: { customerId } })) === 0;
    const data = {
      ...dto,
      line2: dto.line2 || null,
      // on update, an omitted flag (undefined) leaves the current value alone
      isDefaultShipping: dto.isDefaultShipping ?? (id ? undefined : isFirst),
      isDefaultBilling: dto.isDefaultBilling ?? (id ? undefined : isFirst),
    };
    // NOT: { id: undefined } would match nothing, so only exclude the row when updating
    const others = { customerId, ...(id && { NOT: { id } }) };
    return this.db.$transaction(async (tx) => {
      if (data.isDefaultShipping) await tx.address.updateMany({ where: others, data: { isDefaultShipping: false } });
      if (data.isDefaultBilling) await tx.address.updateMany({ where: others, data: { isDefaultBilling: false } });
      return id ? tx.address.update({ where: { id }, data }) : tx.address.create({ data: { ...data, customerId } });
    });
  }

  async create(customerId: string, dto: AddressDto) {
    if ((await this.db.address.count({ where: { customerId } })) >= MAX_ADDRESSES) throw new BadRequestException('Address limit reached.');
    return this.save(customerId, dto);
  }

  async update(customerId: string, id: string, dto: AddressDto) {
    if (!(await this.db.address.findFirst({ where: { id, customerId } }))) throw new NotFoundException();
    return this.save(customerId, dto, id);
  }

  async remove(customerId: string, id: string) {
    const { count } = await this.db.address.deleteMany({ where: { id, customerId } });
    if (!count) throw new NotFoundException();
  }
}

@Controller('addresses')
@UseGuards(AuthGuard)
class AddressController {
  constructor(private readonly addresses: AddressService) {}

  @Get() list(@CurrentCustomer() c: AuthedCustomer) {
    return this.addresses.list(c.id);
  }

  @Post() create(@CurrentCustomer() c: AuthedCustomer, @Body() dto: AddressDto) {
    return this.addresses.create(c.id, dto);
  }

  @Patch(':id') update(@CurrentCustomer() c: AuthedCustomer, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddressDto) {
    return this.addresses.update(c.id, id, dto);
  }

  @Delete(':id') @HttpCode(204) remove(@CurrentCustomer() c: AuthedCustomer, @Param('id', ParseUUIDPipe) id: string) {
    return this.addresses.remove(c.id, id);
  }
}

@Module({ imports: [AuthModule], controllers: [AddressController], providers: [AddressService] })
export class AddressModule {}
