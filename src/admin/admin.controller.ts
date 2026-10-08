import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { DAY, hashToken, newToken } from '../auth/tokens.js';
import { generateChildCode, hashChildCode } from '../children/linking.js';
import { MailService } from '../mail.service.js';
import { PrismaService } from '../prisma.service.js';
import { CurrentStaff, requireSuperadmin, StaffAuthService, StaffGuard, type Staff } from './staff-auth.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const YEAR = /^\d{4}-\d{2}$/; // academic year, e.g. 2026-27

class StaffCreateDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)) @IsEmail() @MaxLength(254) email: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsIn(['SUPERADMIN', 'STAFF']) role: 'SUPERADMIN' | 'STAFF';
}

class StaffUpdateDto {
  @IsOptional() @IsIn(['SUPERADMIN', 'STAFF']) role?: 'SUPERADMIN' | 'STAFF';
  @IsOptional() @IsBoolean() active?: boolean;
}

class SchoolDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(160) name: string;
}

class ChildDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(80) firstName: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(80) lastName: string;
  @Matches(YEAR) academicYear: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(80) className: string;
}

class ImportDto {
  @Matches(YEAR) academicYear: string;
  /** CSV text: first name, last name, class — one child per line; a header row is skipped. */
  @IsString() @MaxLength(500_000) csv: string;
}

class InviteParentDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)) @IsEmail() @MaxLength(254) email: string;
}

const SCHOOL_INVITE_TTL = 30 * DAY; // parents may not act until photos are out; the link only works for this email

class IssueCodesDto {
  @IsUUID() shootId: string;
  @IsArray() @ArrayMaxSize(2000) @IsUUID('4', { each: true }) childIds: string[];
}

@Controller('admin')
@UseGuards(StaffGuard)
export class AdminController {
  constructor(
    private readonly db: PrismaService,
    private readonly auth: StaffAuthService,
    private readonly mail: MailService,
  ) {}

  private audit(staff: Staff, action: string, data: { childId?: string; customerId?: string; ip?: string; detail?: object } = {}) {
    return this.db.auditLog.create({ data: { action, staffId: staff.id, ...data, ip: data.ip ?? null } });
  }

  @Get('me')
  me(@CurrentStaff() staff: Staff) {
    return staff;
  }

  /** Headline numbers and recent activity for the admin overview page. */
  @Get('overview')
  async overview() {
    const [schools, children, parents, links, published, staged, pendingCodes, recent] = await Promise.all([
      this.db.school.count(),
      this.db.child.count(),
      this.db.customer.count({ where: { verifiedAt: { not: null } } }),
      this.db.parentChildLink.count({ where: { status: 'ACTIVE' } }),
      this.db.imageAsset.count({ where: { isAnchor: false, shootId: { not: null } } }),
      this.db.shootPhoto.count({ where: { imageId: null, excluded: false } }),
      this.db.childCode.count({ where: { redeemedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }),
      this.db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 12, select: { id: true, action: true, createdAt: true, staffId: true, customerId: true, childId: true } }),
    ]);
    const staffNames = new Map((await this.db.staffUser.findMany({ where: { id: { in: recent.flatMap((r) => (r.staffId ? [r.staffId] : [])) } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
    return {
      stats: { schools, children, parents, links, published, staged, pendingCodes },
      recent: recent.map((r) => ({ id: r.id, action: r.action, createdAt: r.createdAt, childId: r.childId, by: r.staffId ? (staffNames.get(r.staffId) ?? 'Staff') : r.customerId ? 'Parent' : 'System' })),
    };
  }

  // ── Staff accounts (superadmin only) ────────────────────────────────────────────────────

  @Get('staff')
  staff(@CurrentStaff() me: Staff) {
    requireSuperadmin(me);
    return this.db.staffUser.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, role: true, active: true, lastLoginAt: true, inviteExpiresAt: true },
    });
  }

  @Post('staff')
  async createStaff(@CurrentStaff() me: Staff, @Body() dto: StaffCreateDto) {
    requireSuperadmin(me);
    if (await this.db.staffUser.findUnique({ where: { email: dto.email } })) throw new ConflictException('There is already a staff account with that email.');
    const s = await this.db.staffUser.create({ data: dto });
    await this.auth.issueInvite(s.id);
    await this.audit(me, 'STAFF_CREATED', { detail: { staffId: s.id, role: s.role } });
    return { id: s.id };
  }

  @Patch('staff/:id')
  async updateStaff(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StaffUpdateDto) {
    requireSuperadmin(me);
    if (id === me.id) throw new BadRequestException('You can’t change your own role or deactivate yourself.'); // no accidental lock-out
    const s = await this.db.staffUser.update({ where: { id }, data: dto }).catch(() => null);
    if (!s) throw new NotFoundException();
    if (dto.active === false) await this.db.staffSession.deleteMany({ where: { staffId: id } }); // signed out at once
    await this.audit(me, 'STAFF_UPDATED', { detail: { staffId: id, ...dto } });
    return { ok: true };
  }

  @Post('staff/:id/reset') @HttpCode(200)
  async resetStaff(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) id: string) {
    requireSuperadmin(me);
    if (!(await this.db.staffUser.findUnique({ where: { id } }))) throw new NotFoundException();
    await this.auth.issueInvite(id);
    await this.audit(me, 'STAFF_RESET_SENT', { detail: { staffId: id } });
    return { ok: true };
  }

  // ── Schools ────────────────────────────────────────────────────────────────────────────

  @Get('schools')
  schools() {
    return this.db.school.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, _count: { select: { children: true, shoots: true } } } });
  }

  @Post('schools')
  async createSchool(@CurrentStaff() me: Staff, @Body() dto: SchoolDto) {
    const s = await this.db.school.create({ data: dto });
    await this.audit(me, 'SCHOOL_CREATED', { detail: { schoolId: s.id, name: s.name } });
    return { id: s.id };
  }

  @Patch('schools/:id')
  async renameSchool(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SchoolDto) {
    const s = await this.db.school.update({ where: { id }, data: dto }).catch(() => null);
    if (!s) throw new NotFoundException();
    await this.audit(me, 'SCHOOL_RENAMED', { detail: { schoolId: id, name: dto.name } });
    return { ok: true };
  }

  /** Children of a school, with their class for the chosen year, how many parents are linked, and code status. */
  @Get('schools/:id/children')
  async children(@Param('id', ParseUUIDPipe) id: string, @Query('year') year?: string, @Query('q') q?: string) {
    const school = await this.db.school.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!school) throw new NotFoundException();
    const years = await this.db.enrolment.findMany({ where: { child: { schoolId: id } }, distinct: ['academicYear'], select: { academicYear: true }, orderBy: { academicYear: 'desc' } });
    const academicYear = year && YEAR.test(year) ? year : (years[0]?.academicYear ?? null);
    const search = q?.trim().slice(0, 80);
    const children = await this.db.child.findMany({
      where: {
        schoolId: id,
        ...(academicYear && { enrolments: { some: { academicYear } } }),
        ...(search && { OR: [{ firstName: { contains: search, mode: 'insensitive' } }, { lastName: { contains: search, mode: 'insensitive' } }] }),
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      take: 1000, // ponytail: no paging; a school is a few hundred children
      select: {
        id: true,
        firstName: true,
        lastName: true,
        enrolments: { where: { academicYear: academicYear ?? undefined }, select: { className: true } },
        _count: { select: { links: { where: { status: 'ACTIVE' } } } },
        codes: { orderBy: { createdAt: 'desc' }, take: 1, select: { redeemedAt: true, expiresAt: true } },
      },
    });
    const now = new Date();
    return {
      school,
      academicYear,
      years: years.map((y) => y.academicYear),
      children: children.map((c) => {
        const code = c.codes[0];
        return {
          id: c.id,
          firstName: c.firstName,
          lastName: c.lastName,
          className: c.enrolments[0]?.className ?? null,
          linkedParents: c._count.links,
          code: !code ? 'NONE' : code.redeemedAt ? 'REDEEMED' : code.expiresAt && code.expiresAt <= now ? 'REVOKED' : 'ISSUED',
        };
      }),
    };
  }

  @Post('schools/:id/children')
  async addChild(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) schoolId: string, @Body() dto: ChildDto) {
    if (!(await this.db.school.findUnique({ where: { id: schoolId } }))) throw new NotFoundException();
    const c = await this.db.child.create({
      data: { schoolId, firstName: dto.firstName, lastName: dto.lastName, enrolments: { create: { academicYear: dto.academicYear, className: dto.className } } },
    });
    await this.audit(me, 'CHILD_CREATED', { childId: c.id });
    return { id: c.id };
  }

  /** Bulk add from a school's class list. Children already in the same class that year are skipped. */
  @Post('schools/:id/children/import')
  async importChildren(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) schoolId: string, @Body() dto: ImportDto) {
    if (!(await this.db.school.findUnique({ where: { id: schoolId } }))) throw new NotFoundException();
    const rows = parseClassList(dto.csv);
    if ('error' in rows) throw new BadRequestException(rows.error);
    const existing = await this.db.child.findMany({
      where: { schoolId, enrolments: { some: { academicYear: dto.academicYear } } },
      select: { firstName: true, lastName: true, enrolments: { where: { academicYear: dto.academicYear }, select: { className: true } } },
    });
    const key = (f: string, l: string, c: string) => `${f}|${l}|${c}`.toLowerCase();
    const seen = new Set(existing.map((c) => key(c.firstName, c.lastName, c.enrolments[0].className)));
    const fresh = rows.filter((r) => !seen.has(key(r.firstName, r.lastName, r.className)) && seen.add(key(r.firstName, r.lastName, r.className)));
    await this.db.$transaction(
      fresh.map((r) =>
        this.db.child.create({ data: { schoolId, firstName: r.firstName, lastName: r.lastName, enrolments: { create: { academicYear: dto.academicYear, className: r.className } } } }),
      ),
    );
    await this.audit(me, 'CHILDREN_IMPORTED', { detail: { schoolId, academicYear: dto.academicYear, added: fresh.length, skipped: rows.length - fresh.length } });
    return { added: fresh.length, skipped: rows.length - fresh.length };
  }

  // ── Children ───────────────────────────────────────────────────────────────────────────

  @Get('children/:id')
  async child(@Param('id', ParseUUIDPipe) id: string) {
    const c = await this.db.child.findUnique({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        school: { select: { id: true, name: true } },
        enrolments: { orderBy: { academicYear: 'desc' }, select: { academicYear: true, className: true } },
        links: { orderBy: { createdAt: 'asc' }, select: { id: true, status: true, verifiedAt: true, customer: { select: { email: true, firstName: true, lastName: true } } } },
        codes: { orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, redeemedAt: true, expiresAt: true, shoot: { select: { id: true, name: true } } } },
        invites: { orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, email: true, createdAt: true, expiresAt: true, acceptedAt: true, staffId: true } },
        _count: { select: { images: true } },
      },
    });
    if (!c) throw new NotFoundException();
    const history = await this.db.auditLog.findMany({ where: { childId: id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, action: true, createdAt: true, ip: true, customerId: true, staffId: true } });
    const now = new Date();
    const codes = c.codes.map((k) => ({ ...k, status: k.redeemedAt ? 'REDEEMED' : k.expiresAt && k.expiresAt <= now ? 'REVOKED' : 'ISSUED' }));
    const invites = c.invites.map(({ staffId, ...i }) => ({ ...i, fromSchool: staffId !== null }));
    return { ...c, codes, invites, history };
  }

  /**
   * Brief §5 "school-verified contact push": emails a single-use invitation to a parent contact the school holds.
   * Only staff can send these, so a parent can never point an invitation at a child. Accepting needs an account
   * with this email (same flow and page as guardian invites), so a forwarded link is useless.
   */
  @Post('children/:id/invites')
  async inviteParent(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InviteParentDto, @Req() req: Request) {
    const child = await this.db.child.findUnique({
      where: { id },
      select: { firstName: true, school: { select: { name: true } }, links: { where: { status: 'ACTIVE', customer: { email: dto.email } }, select: { id: true } } },
    });
    if (!child) throw new NotFoundException();
    if (child.links.length) throw new ConflictException('That parent already has access.');
    const token = newToken();
    await this.db.guardianInvite.create({ data: { childId: id, staffId: me.id, email: dto.email, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + SCHOOL_INVITE_TTL) } });
    await this.audit(me, 'SCHOOL_INVITED', { childId: id, ip: req.ip, detail: { email: dto.email } });
    await this.mail.send(
      dto.email,
      `See ${child.firstName}’s school photos on Springpad`,
      `${child.school.name} has invited you to see ${child.firstName}’s school photos on Springpad.\n\nSign in or create an account with this email address (${dto.email}), then accept here:\n${process.env.STOREFRONT_URL}/guardian-invite?token=${token}\n\nThis invitation expires in 30 days. If you weren’t expecting it, you can ignore this email.`,
    );
    return { ok: true };
  }

  @Patch('children/:id')
  async updateChild(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChildDto) {
    const c = await this.db.child.update({ where: { id }, data: { firstName: dto.firstName, lastName: dto.lastName } }).catch(() => null);
    if (!c) throw new NotFoundException();
    await this.db.enrolment.upsert({
      where: { childId_academicYear: { childId: id, academicYear: dto.academicYear } },
      create: { childId: id, academicYear: dto.academicYear, className: dto.className },
      update: { className: dto.className },
    });
    await this.audit(me, 'CHILD_UPDATED', { childId: id });
    return { ok: true };
  }

  /**
   * New ID-card codes for one shoot (photo day). Photo matching only accepts the codes issued for that shoot.
   * A child's earlier unused code for the same shoot stops working; codes from other shoots are untouched.
   * The plain codes are returned once, for printing, and never stored or logged (only their hashes are).
   */
  @Post('codes') @HttpCode(200)
  async issueCodes(@CurrentStaff() me: Staff, @Body() dto: IssueCodesDto, @Req() req: Request) {
    const shoot = await this.db.shoot.findUnique({ where: { id: dto.shootId }, select: { id: true, name: true, schoolId: true, academicYear: true } });
    if (!shoot) throw new NotFoundException();
    const children = await this.db.child.findMany({
      where: { id: { in: dto.childIds }, schoolId: shoot.schoolId }, // only this shoot's school
      select: { id: true, firstName: true, lastName: true, school: { select: { name: true } }, enrolments: { where: { academicYear: shoot.academicYear }, select: { className: true } } },
    });
    if (children.length !== new Set(dto.childIds).size) throw new BadRequestException('Some of those children aren’t at this shoot’s school.');
    const issued = children.map((c) => ({ ...c, code: generateChildCode() }));
    const now = new Date();
    await this.db.$transaction([
      this.db.childCode.updateMany({ where: { childId: { in: issued.map((c) => c.id) }, shootId: shoot.id, redeemedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, data: { expiresAt: now } }),
      this.db.childCode.createMany({ data: issued.map((c) => ({ childId: c.id, shootId: shoot.id, codeHash: hashChildCode(c.code) })) }),
      this.db.auditLog.createMany({ data: issued.map((c) => ({ action: 'CODE_ISSUED', staffId: me.id, childId: c.id, ip: req.ip ?? null, detail: { shootId: shoot.id } })) }),
    ]);
    return issued.map((c) => ({
      childId: c.id,
      name: `${c.firstName} ${c.lastName}`,
      school: c.school.name,
      className: c.enrolments[0]?.className ?? '',
      academicYear: shoot.academicYear,
      shoot: shoot.name,
      code: c.code,
    }));
  }

  /** Stops a child's unredeemed code working (e.g. a lost card). Existing parent links are untouched. */
  @Post('children/:id/codes/revoke') @HttpCode(200)
  async revokeCodes(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const now = new Date();
    const r = await this.db.childCode.updateMany({ where: { childId: id, redeemedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, data: { expiresAt: now } });
    await this.audit(me, 'CODE_REVOKED', { childId: id, detail: { count: r.count } });
    return { revoked: r.count };
  }

  /** Removes a parent's access to a child. */
  @Post('links/:id/revoke') @HttpCode(200)
  async revokeLink(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const link = await this.db.parentChildLink.update({ where: { id }, data: { status: 'REVOKED' } }).catch(() => null);
    if (!link) throw new NotFoundException();
    await this.audit(me, 'LINK_REVOKED', { childId: link.childId, customerId: link.customerId });
    return { ok: true };
  }
}

/** "first,last,class" lines → rows. A header row (containing "first") is skipped. */
export function parseClassList(csv: string): { firstName: string; lastName: string; className: string }[] | { error: string } {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0]?.toLowerCase().includes('first')) lines.shift();
  if (!lines.length) return { error: 'The file has no children in it.' };
  if (lines.length > 2000) return { error: 'Please import at most 2,000 children at a time.' };
  const rows = [];
  for (const [i, line] of lines.entries()) {
    // ponytail: plain comma split, no quoted fields; class lists don't have commas in names
    const [firstName, lastName, className] = line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    if (!firstName || !lastName || !className || [firstName, lastName, className].some((s) => s.length > 80)) {
      return { error: `Line ${i + 1} needs a first name, last name and class: "${line.slice(0, 60)}"` };
    }
    rows.push({ firstName, lastName, className });
  }
  return rows;
}
