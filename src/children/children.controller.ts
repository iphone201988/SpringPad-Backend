import { Body, Controller, Get, HttpCode, Ip, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { AuthGuard, CurrentCustomer, type AuthedCustomer } from '../auth/auth.guard.js';
import { ChildrenService } from './children.service.js';

class RedeemCodeDto {
  @IsString() @IsNotEmpty() @MaxLength(40) code: string;
}
class InviteDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail() @MaxLength(254) email: string;
}
class AcceptDto {
  @IsString() @IsNotEmpty() @MaxLength(200) token: string;
}

const strict = Throttle({ default: { limit: 5, ttl: 60_000 } });

@Controller()
@UseGuards(AuthGuard)
export class ChildrenController {
  constructor(private readonly children: ChildrenService) {}

  @Get('children')
  list(@CurrentCustomer() c: AuthedCustomer) {
    return this.children.listForCustomer(c.id);
  }

  @Post('children/redeem') @HttpCode(200) @strict
  redeem(@CurrentCustomer() c: AuthedCustomer, @Body() dto: RedeemCodeDto, @Ip() ip: string) {
    return this.children.redeem(c.id, dto.code, ip);
  }

  // No endpoint lists who else has access to a child (brief §5); you can only invite.
  @Post('children/:id/guardians') @HttpCode(202) @strict
  async invite(@CurrentCustomer() c: AuthedCustomer, @Param('id', ParseUUIDPipe) childId: string, @Body() dto: InviteDto, @Ip() ip: string) {
    await this.children.inviteGuardian(c, childId, dto.email, ip);
  }

  @Post('guardian-invites/accept') @HttpCode(200) @strict
  accept(@CurrentCustomer() c: AuthedCustomer, @Body() dto: AcceptDto, @Ip() ip: string) {
    return this.children.acceptInvite(c, dto.token, ip);
  }
}
