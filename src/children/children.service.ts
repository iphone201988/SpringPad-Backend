import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { DAY, hashToken, newToken } from '../auth/tokens.js';
import { MailService } from '../mail.service.js';
import { PrismaService } from '../prisma.service.js';
import { audit, hashChildCode, redeemCodeHash } from './linking.js';

const MAX_FAILED_PER_HOUR = 10; // per account, on top of the per-IP limit
const INVITE_TTL = 7 * DAY;
const INVALID = "That code isn't valid. Check it against your child's card and try again.";

@Injectable()
export class ChildrenService {
  constructor(
    private readonly db: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** Children this parent may see. The only way to reach a child — there is no search or browse. */
  async listForCustomer(customerId: string) {
    const links = await this.db.parentChildLink.findMany({
      where: { customerId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: {
        child: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            school: { select: { name: true } },
            enrolments: { orderBy: { academicYear: 'desc' }, take: 1, select: { academicYear: true, className: true } },
          },
        },
      },
    });
    return links.map(({ child: { enrolments, ...c } }) => ({ ...c, currentClass: enrolments[0] ?? null }));
  }

  async redeem(customerId: string, code: string, ip?: string) {
    const failures = await this.db.auditLog.count({
      where: { customerId, action: 'CODE_REDEEM_FAILED', createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    if (failures >= MAX_FAILED_PER_HOUR) throw new HttpException('Too many attempts. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);
    const childId = await redeemCodeHash(this.db, customerId, hashChildCode(code), ip);
    if (!childId) throw new BadRequestException(INVALID);
    return (await this.listForCustomer(customerId)).find((c) => c.id === childId);
  }

  /** Throws 404 unless the parent is actively linked — same answer whether or not the child exists. */
  private async assertLinked(customerId: string, childId: string) {
    const link = await this.db.parentChildLink.findUnique({ where: { customerId_childId: { customerId, childId } } });
    if (link?.status !== 'ACTIVE') throw new NotFoundException();
  }

  async inviteGuardian(inviter: { id: string; email: string; firstName: string }, childId: string, email: string, ip?: string) {
    await this.assertLinked(inviter.id, childId);
    if (email === inviter.email) throw new BadRequestException('You already have access.');
    const token = newToken();
    await this.db.guardianInvite.create({
      data: { childId, invitedById: inviter.id, email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL) },
    });
    await audit(this.db, 'GUARDIAN_INVITED', { customerId: inviter.id, childId, ip, detail: { email } });
    await this.mail.send(
      email,
      `${inviter.firstName} invited you to Springpad`,
      `${inviter.firstName} has invited you to see your child's school photos on Springpad.\n\nSign in or create an account with this email address (${email}), then accept here:\n${process.env.STOREFRONT_URL}/guardian-invite?token=${token}\n\nThis invitation expires in 7 days.`,
    );
  }

  /** Accepting needs the account whose email the invite was sent to, so a forwarded link is useless. */
  async acceptInvite(customer: { id: string; email: string }, token: string, ip?: string) {
    const claimed = await this.db.guardianInvite.updateManyAndReturn({
      where: { tokenHash: hashToken(token), email: customer.email, acceptedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date(), acceptedBy: customer.id },
    });
    if (!claimed.length) {
      await audit(this.db, 'GUARDIAN_ACCEPT_FAILED', { customerId: customer.id, ip });
      throw new BadRequestException('This invitation is invalid, has expired, or was sent to a different email address.');
    }
    const { childId, invitedById } = claimed[0];
    await this.db.parentChildLink.upsert({
      where: { customerId_childId: { customerId: customer.id, childId } },
      create: { customerId: customer.id, childId },
      update: { status: 'ACTIVE', verifiedAt: new Date() },
    });
    await audit(this.db, 'GUARDIAN_ACCEPTED', { customerId: customer.id, childId, ip, detail: { invitedById } });
    return (await this.listForCustomer(customer.id)).find((c) => c.id === childId);
  }
}
