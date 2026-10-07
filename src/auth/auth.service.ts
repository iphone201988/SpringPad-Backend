import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import argon2 from 'argon2';
import { EmailTokenType } from '../generated/prisma/enums.js';
import { hashChildCode, redeemCodeHash } from '../children/linking.js';
import { MailService } from '../mail.service.js';
import { PrismaService } from '../prisma.service.js';
import type { ChangeEmailDto, ChangePasswordDto, LoginDto, RegisterDto, ResetPasswordDto, UpdateProfileDto } from './dto.js';
import { DAY, HOUR, hashToken, newToken } from './tokens.js';

const SESSION_TTL = 30 * DAY;
const TTL = { VERIFY: DAY, RESET: HOUR, CHANGE_EMAIL: DAY } as const;
const PUBLIC_FIELDS = { id: true, email: true, firstName: true, lastName: true, displayName: true } as const;

// Used when the email doesn't exist, so a failed login takes as long either way (no account probing by timing).
let dummyHash: Promise<string> | undefined;

@Injectable()
export class AuthService {
  constructor(
    private readonly db: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** Always succeeds from the caller's point of view, so it can't reveal which emails are registered. */
  async register(dto: RegisterDto) {
    const existing = await this.db.customer.findUnique({ where: { email: dto.email } });
    if (existing?.verifiedAt) return; // ponytail: could email "you already have an account"; silent for now
    const data = {
      passwordHash: await argon2.hash(dto.password),
      firstName: dto.firstName,
      lastName: dto.lastName,
      pendingCodeHash: dto.childCode?.trim() ? hashChildCode(dto.childCode) : null,
    };
    const customer = existing
      ? await this.db.customer.update({ where: { id: existing.id }, data })
      : await this.db.customer.create({ data: { email: dto.email, ...data } });
    const token = await this.issueEmailToken(customer.id, EmailTokenType.VERIFY);
    await this.mail.send(customer.email, 'Verify your Springpad account', `Hi ${customer.firstName},\n\nConfirm your email to activate your account:\n${process.env.STOREFRONT_URL}/verify?token=${token}\n\nThis link expires in 24 hours.`);
  }

  async verify(token: string, ip?: string) {
    await this.consumeEmailToken(token, EmailTokenType.VERIFY, async (customerId) => {
      const before = await this.db.customer.findUniqueOrThrow({ where: { id: customerId }, select: { pendingCodeHash: true } });
      await this.db.customer.update({ where: { id: customerId }, data: { verifiedAt: new Date(), pendingCodeHash: null } });
      // The sign-up child code only counts once the parent has proven they own the email (brief §5).
      // A bad code is just audit-logged; they can add one later from the header.
      if (before.pendingCodeHash) await redeemCodeHash(this.db, customerId, before.pendingCodeHash, ip);
    });
  }

  async login(dto: LoginDto) {
    const customer = await this.db.customer.findUnique({ where: { email: dto.email } });
    const ok = await argon2.verify(customer?.passwordHash ?? (await (dummyHash ??= argon2.hash(newToken()))), dto.password);
    if (!customer || !ok) throw new UnauthorizedException('Email or password is incorrect.');
    // Only revealed after the correct password, so it doesn't leak whether an email exists.
    if (!customer.verifiedAt) {
      const token = await this.issueEmailToken(customer.id, EmailTokenType.VERIFY);
      await this.mail.send(
        customer.email,
        'Verify your Springpad account',
        `Hi ${customer.firstName},\n\nConfirm your email to activate your account:\n${process.env.STOREFRONT_URL}/verify?token=${token}\n\nThis link expires in 24 hours.`,
      );
      throw new ForbiddenException({
        message: 'Please verify your email first. A new verification link has been sent to your inbox.',
        code: 'NOT_VERIFIED',
      });
    }
    const token = newToken();
    await this.db.session.create({ data: { tokenHash: hashToken(token), customerId: customer.id, expiresAt: new Date(Date.now() + SESSION_TTL) } });
    return { token, expiresAt: new Date(Date.now() + SESSION_TTL) };
  }

  logout(token: string) {
    return this.db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }

  /** Session token → customer, or null if missing/expired. */
  async customerForSession(token: string) {
    const session = await this.db.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { customer: { select: PUBLIC_FIELDS } },
    });
    if (!session || session.expiresAt < new Date()) return null;
    return { sessionId: session.id, ...session.customer };
  }

  async requestPasswordReset(email: string) {
    const customer = await this.db.customer.findUnique({ where: { email } });
    if (!customer?.verifiedAt) return; // same response either way
    const token = await this.issueEmailToken(customer.id, EmailTokenType.RESET);
    await this.mail.send(customer.email, 'Reset your Springpad password', `Hi ${customer.firstName},\n\nReset your password here:\n${process.env.STOREFRONT_URL}/reset-password?token=${token}\n\nThis link expires in 1 hour. If you didn't ask for this, you can ignore this email.`);
  }

  async resetPassword(dto: ResetPasswordDto) {
    const passwordHash = await argon2.hash(dto.password);
    await this.consumeEmailToken(dto.token, EmailTokenType.RESET, (customerId) =>
      this.db.$transaction([
        this.db.customer.update({ where: { id: customerId }, data: { passwordHash } }),
        this.db.session.deleteMany({ where: { customerId } }), // sign out everywhere
      ]),
    );
  }

  updateProfile(customerId: string, dto: UpdateProfileDto) {
    return this.db.customer.update({ where: { id: customerId }, data: dto, select: PUBLIC_FIELDS });
  }

  async changePassword(customerId: string, sessionId: string, dto: ChangePasswordDto) {
    const customer = await this.db.customer.findUniqueOrThrow({ where: { id: customerId } });
    if (!(await argon2.verify(customer.passwordHash, dto.currentPassword))) throw new UnauthorizedException('Your current password is incorrect.');
    await this.db.$transaction([
      this.db.customer.update({ where: { id: customerId }, data: { passwordHash: await argon2.hash(dto.newPassword) } }),
      this.db.session.deleteMany({ where: { customerId, NOT: { id: sessionId } } }), // other devices signed out
    ]);
  }

  private async issueEmailToken(customerId: string, type: EmailTokenType, newEmail?: string) {
    const token = newToken();
    await this.db.$transaction([
      this.db.emailToken.deleteMany({ where: { customerId, type, usedAt: null } }), // only the newest link works
      this.db.emailToken.create({ data: { customerId, type, newEmail, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + TTL[type]) } }),
    ]);
    return token;
  }

  /** Needs the current password; the new address only takes effect once its owner clicks the link. */
  async requestEmailChange(customerId: string, dto: ChangeEmailDto) {
    const customer = await this.db.customer.findUniqueOrThrow({ where: { id: customerId } });
    if (!(await argon2.verify(customer.passwordHash, dto.password))) throw new UnauthorizedException('Your password is incorrect.');
    if (dto.newEmail === customer.email) throw new BadRequestException('That is already your email address.');
    // Same response if the address is taken, so this can't be used to discover other accounts.
    if (await this.db.customer.findUnique({ where: { email: dto.newEmail } })) return;
    const token = await this.issueEmailToken(customerId, EmailTokenType.CHANGE_EMAIL, dto.newEmail);
    await this.mail.send(dto.newEmail, 'Confirm your new Springpad email', `Hi ${customer.firstName},\n\nConfirm this as your new sign-in email:\n${process.env.STOREFRONT_URL}/account/verify-email?token=${token}\n\nThis link expires in 24 hours.`);
    await this.mail.send(customer.email, 'Your Springpad email is being changed', `Hi ${customer.firstName},\n\nSomeone (hopefully you) asked to change your Springpad sign-in email to ${dto.newEmail}. If this wasn't you, change your password straight away.`);
  }

  async confirmEmailChange(token: string) {
    await this.consumeEmailToken(token, EmailTokenType.CHANGE_EMAIL, async (customerId, newEmail) => {
      if (!newEmail || (await this.db.customer.findUnique({ where: { email: newEmail } }))) throw new BadRequestException('This link is invalid or has expired.');
      await this.db.customer.update({ where: { id: customerId }, data: { email: newEmail } });
    });
  }

  private async consumeEmailToken(token: string, type: EmailTokenType, apply: (customerId: string, newEmail: string | null) => Promise<unknown>) {
    // Atomic claim: only one request can mark a given token used.
    const claimed = await this.db.emailToken.updateManyAndReturn({
      where: { tokenHash: hashToken(token), type, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (!claimed.length) throw new BadRequestException('This link is invalid or has expired.');
    await apply(claimed[0].customerId, claimed[0].newEmail);
  }
}
