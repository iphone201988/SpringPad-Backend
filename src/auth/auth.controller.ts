import { Body, Controller, Get, HttpCode, Ip, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthGuard, bearer, CurrentCustomer, type AuthedCustomer } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { ChangeEmailDto, ChangePasswordDto, EmailDto, LoginDto, RegisterDto, ResetPasswordDto, TokenDto, UpdateProfileDto } from './dto.js';

// Stricter limit on endpoints worth brute-forcing: 5 requests / minute / IP.
const strict = Throttle({ default: { limit: 5, ttl: 60_000 } });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register') @HttpCode(202) @strict
  async register(@Body() dto: RegisterDto) {
    await this.auth.register(dto);
  }

  @Post('verify') @HttpCode(204) @strict
  verify(@Body() dto: TokenDto, @Ip() ip: string) {
    return this.auth.verify(dto.token, ip);
  }

  @Post('login') @HttpCode(200) @strict
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Post('logout') @HttpCode(204)
  async logout(@Req() req: Request) {
    const token = bearer(req);
    if (token) await this.auth.logout(token);
  }

  @Post('forgot-password') @HttpCode(202) @strict
  async forgotPassword(@Body() dto: EmailDto) {
    await this.auth.requestPasswordReset(dto.email);
  }

  @Post('reset-password') @HttpCode(204) @strict
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }

  @Post('confirm-email') @HttpCode(204) @strict
  confirmEmail(@Body() dto: TokenDto) {
    return this.auth.confirmEmailChange(dto.token);
  }
}

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  me(@CurrentCustomer() { sessionId: _, ...customer }: AuthedCustomer) {
    return customer;
  }

  @Patch()
  update(@CurrentCustomer() c: AuthedCustomer, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(c.id, dto);
  }

  @Post('email') @HttpCode(202) @strict
  async changeEmail(@CurrentCustomer() c: AuthedCustomer, @Body() dto: ChangeEmailDto) {
    await this.auth.requestEmailChange(c.id, dto);
  }

  @Patch('password') @HttpCode(204) @strict
  changePassword(@CurrentCustomer() c: AuthedCustomer, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(c.id, c.sessionId, dto);
  }
}
