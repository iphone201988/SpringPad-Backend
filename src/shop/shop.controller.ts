import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Logger, Param, ParseUUIDPipe, Post, Query, Req, UseGuards, type RawBodyRequest } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { AuthGuard, CurrentCustomer, type AuthedCustomer } from '../auth/auth.guard.js';
import { stripe } from './payments.js';
import { ShopService } from './shop.service.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class AddLineDto {
  @IsUUID() imageId: string;
  @IsString() @MaxLength(40) sizeCode: string; // checked against the catalogue when priced
  @IsString() @MaxLength(40) frameCode: string;
  @IsBoolean() mat: boolean;
  @IsInt() @Min(1) @Max(20) quantity: number = 1;
}

class CheckoutDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)) @IsEmail() @MaxLength(254) email: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(400) address: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(40) promo?: string;
}

const uuid = new ParseUUIDPipe();

@Controller()
@UseGuards(AuthGuard)
export class ShopController {
  constructor(private readonly shop: ShopService) {}

  // ?promo=CODE previews the discount; throttled so codes can't be guessed by brute force
  @Get('basket') @Throttle({ default: { limit: 30, ttl: 60_000 } })
  basket(@CurrentCustomer() c: AuthedCustomer, @Query('promo') promo?: string) {
    return this.shop.basket(c.id, promo?.slice(0, 40));
  }

  @Post('basket') @HttpCode(200)
  add(@CurrentCustomer() c: AuthedCustomer, @Body() dto: AddLineDto) {
    return this.shop.addToBasket(c.id, dto);
  }

  @Delete('basket/:lineId') @HttpCode(200)
  remove(@CurrentCustomer() c: AuthedCustomer, @Param('lineId', uuid) id: string) {
    return this.shop.removeFromBasket(c.id, id);
  }

  @Post('checkout') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60_000 } })
  checkout(@CurrentCustomer() c: AuthedCustomer, @Body() dto: CheckoutDto) {
    const { promo, ...shipping } = dto;
    return this.shop.checkout(c.id, shipping, promo);
  }

  @Get('orders')
  orders(@CurrentCustomer() c: AuthedCustomer, @Query('status') status?: string) {
    const valid = ['PAID', 'CANCELLED', 'REFUNDED'] as const;
    return this.shop.orders(c.id, valid.find((v) => v === status));
  }

  @Get('payment-methods')
  paymentMethods(@CurrentCustomer() c: AuthedCustomer) {
    return this.shop.paymentMethods(c.id);
  }

  @Post('payment-methods') @HttpCode(200) @Throttle({ default: { limit: 10, ttl: 60_000 } })
  addPaymentMethod(@CurrentCustomer() c: AuthedCustomer) {
    return this.shop.addPaymentMethod(c.id);
  }

  @Delete('payment-methods/:id') @HttpCode(204)
  removePaymentMethod(@CurrentCustomer() c: AuthedCustomer, @Param('id') id: string) {
    if (!/^pm_\w+$/.test(id)) throw new BadRequestException();
    return this.shop.removePaymentMethod(c.id, id);
  }

  @Get('orders/:id')
  order(@CurrentCustomer() c: AuthedCustomer, @Param('id', uuid) id: string) {
    return this.shop.order(c.id, id);
  }

  @Get('downloads')
  downloads(@CurrentCustomer() c: AuthedCustomer) {
    return this.shop.downloads(c.id);
  }
}

// Stripe → us. Authenticated by Stripe's signature over the raw body, not by a session.
@Controller('webhooks')
@SkipThrottle()
export class StripeWebhookController {
  private readonly log = new Logger('StripeWebhook');
  constructor(private readonly shop: ShopService) {}

  @Post('stripe') @HttpCode(200)
  async handle(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string) {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) throw new BadRequestException('Stripe not configured');
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody!, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw new BadRequestException('Bad signature');
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.payment_status === 'paid' && session.metadata?.orderId) {
        await this.shop.markPaid(session.metadata.orderId);
        this.log.log(`order ${session.metadata.orderId} paid`);
      }
    }
    return { received: true };
  }
}
