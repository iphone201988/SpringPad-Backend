import {
  Body,
  Controller,
  createParamDecorator,
  ForbiddenException,
  HttpCode,
  Injectable,
  Post,
  Req,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, IsUUID, Length, Matches, MaxLength, MinLength } from 'class-validator';
import argon2 from 'argon2';
import { randomInt } from 'node:crypto';
import type { Request } from 'express';
import { bearer } from '../auth/auth.guard.js';
import { DAY, HOUR, hashToken, newToken } from '../auth/tokens.js';
import { MailService } from '../mail.service.js';
import { PrismaService } from '../prisma.service.js';

const SESSION_TTL = 12 * HOUR;
const CODE_TTL = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
export const INVITE_TTL = 3 * DAY;

export type Staff = { id: string; email: string; name: string; role: 'SUPERADMIN' | 'STAFF' };
type StaffRequest = Request & { staff?: Staff };

let dummyHash: Promise<string> | undefined; // equal timing for unknown emails

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

class StaffLoginDto {
  @Transform(lower) @IsEmail() @MaxLength(254) email: string;
  @IsString() @MaxLength(200) password: string;
}

class StaffCodeDto {
  @IsUUID() challengeId: string;
  @Matches(/^\d{6}$/) code: string;
}

class SetPasswordDto {
  @IsString() @Length(20, 100) token: string;
  @IsString() @MinLength(12) @MaxLength(200) password: string;
}

@Injectable()
export class StaffAuthService {
  constructor(
    private readonly db: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** Step 1: password. Emails a 6-digit code and returns the challenge to answer. */
  async login(email: string, password: string) {
    const staff = await this.db.staffUser.findUnique({ where: { email } });
    const ok = await argon2.verify(staff?.passwordHash ?? (await (dummyHash ??= argon2.hash(newToken()))), password);
    if (!staff || !staff.active || !staff.passwordHash || !ok) throw new UnauthorizedException('Email or password is incorrect.');
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const challenge = await this.db.staffLoginChallenge.create({
      data: { staffId: staff.id, codeHash: hashToken(`staff-code:${code}`), expiresAt: new Date(Date.now() + CODE_TTL) },
    });
    await this.mail.send(staff.email, `Your Springpad admin sign-in code: ${code}`, `Hi ${staff.name},\n\nYour sign-in code is ${code}. It expires in 10 minutes.\n\nIf this wasn't you, change your password and tell a superadmin.`);
    return { challengeId: challenge.id };
  }

  /** Step 2: the emailed code. Five wrong tries and the challenge is dead; they start again. */
  async verifyCode(challengeId: string, code: string, ip?: string) {
    const c = await this.db.staffLoginChallenge.findUnique({ where: { id: challengeId }, include: { staff: true } });
    const live = c && !c.consumedAt && c.expiresAt > new Date() && c.attempts < MAX_CODE_ATTEMPTS && c.staff.active;
    if (!live) throw new UnauthorizedException('That code has expired. Please sign in again.');
    if (c.codeHash !== hashToken(`staff-code:${code}`)) {
      await this.db.staffLoginChallenge.update({ where: { id: c.id }, data: { attempts: { increment: 1 } } });
      throw new UnauthorizedException('That code is incorrect.');
    }
    // Single use, even if two requests race with the right code.
    const claimed = await this.db.staffLoginChallenge.updateMany({ where: { id: c.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (!claimed.count) throw new UnauthorizedException('That code has expired. Please sign in again.');
    const token = newToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL);
    await this.db.staffSession.create({ data: { tokenHash: hashToken(token), staffId: c.staffId, expiresAt } });
    await this.db.staffUser.update({ where: { id: c.staffId }, data: { lastLoginAt: new Date() } });
    await this.db.auditLog.create({ data: { action: 'STAFF_LOGIN', staffId: c.staffId, ip: ip ?? null } });
    return { token, expiresAt };
  }

  async staffForSession(token: string): Promise<Staff | null> {
    const s = await this.db.staffSession.findUnique({ where: { tokenHash: hashToken(token) }, include: { staff: true } });
    if (!s || s.expiresAt <= new Date() || !s.staff.active) return null;
    const { id, email, name, role } = s.staff;
    return { id, email, name, role };
  }

  logout(token: string) {
    return this.db.staffSession.deleteMany({ where: { tokenHash: hashToken(token) } });
  }

  /** New set-password link (first invite, or a reset by a superadmin). Returns the link. */
  async issueInvite(staffId: string) {
    const token = newToken();
    const staff = await this.db.staffUser.update({
      where: { id: staffId },
      data: { inviteTokenHash: hashToken(token), inviteExpiresAt: new Date(Date.now() + INVITE_TTL) },
    });
    const link = `${process.env.STOREFRONT_URL}/admin/set-password?token=${token}`;
    await this.mail.send(staff.email, 'Set your Springpad admin password', `Hi ${staff.name},\n\nSet your password for the Springpad admin:\n${link}\n\nThis link expires in 3 days.`);
    return link;
  }

  async setPassword(token: string, password: string) {
    const staff = await this.db.staffUser.findUnique({ where: { inviteTokenHash: hashToken(token) } });
    if (!staff || !staff.active || !staff.inviteExpiresAt || staff.inviteExpiresAt <= new Date()) {
      throw new UnauthorizedException('This link is invalid or has expired. Ask a superadmin for a new one.');
    }
    await this.db.staffUser.update({ where: { id: staff.id }, data: { passwordHash: await argon2.hash(password), inviteTokenHash: null, inviteExpiresAt: null } });
    await this.db.staffSession.deleteMany({ where: { staffId: staff.id } }); // a reset signs out everywhere
    await this.db.auditLog.create({ data: { action: 'STAFF_PASSWORD_SET', staffId: staff.id } });
  }
}

/** Requires a staff session (Authorization: Bearer …, sent by the Next.js server from its admin cookie). */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(private readonly auth: StaffAuthService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<StaffRequest>();
    const token = bearer(req);
    const staff = token && (await this.auth.staffForSession(token));
    if (!staff) throw new UnauthorizedException();
    req.staff = staff;
    return true;
  }
}

export const CurrentStaff = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<StaffRequest>().staff!);

export function requireSuperadmin(staff: Staff) {
  if (staff.role !== 'SUPERADMIN') throw new ForbiddenException('Only a superadmin can do that.');
}

const strict = Throttle({ default: { limit: 5, ttl: 60_000 } });

@Controller('admin/auth')
export class StaffAuthController {
  constructor(private readonly auth: StaffAuthService) {}

  @Post('login') @HttpCode(200) @strict
  login(@Body() dto: StaffLoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Post('verify') @HttpCode(200) @strict
  verify(@Body() dto: StaffCodeDto, @Req() req: Request) {
    return this.auth.verifyCode(dto.challengeId, dto.code, req.ip);
  }

  @Post('set-password') @HttpCode(204) @strict
  setPassword(@Body() dto: SetPasswordDto) {
    return this.auth.setPassword(dto.token, dto.password);
  }

  @Post('logout') @HttpCode(204)
  async logout(@Req() req: Request) {
    const token = bearer(req);
    if (token) await this.auth.logout(token);
  }
}
