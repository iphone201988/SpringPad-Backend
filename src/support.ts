import { Body, Controller, HttpCode, Logger, Module, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { MailService } from './mail.service.js';
import { PrismaService } from './prisma.service.js';

export const SUPPORT_SUBJECTS = ['Lost Child Code', 'Order Tracking', 'Sibling Linking', 'Frame or Print Quality', 'School Booking', 'General Question'];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class SupportDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value)) @IsEmail() @MaxLength(254) email: string;
  @IsIn(SUPPORT_SUBJECTS) subject: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(160) schoolName?: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(5000) message: string;
}

// Public Help-page contact form: saved, then the support inbox is emailed. No login needed.
@Controller('support')
export class SupportController {
  private readonly log = new Logger('Support');
  constructor(
    private readonly db: PrismaService,
    private readonly mail: MailService,
  ) {}

  @Post() @HttpCode(201) @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async create(@Body() dto: SupportDto) {
    const r = await this.db.supportRequest.create({ data: { ...dto, schoolName: dto.schoolName || null } });
    const inbox = process.env.SUPPORT_EMAIL;
    if (inbox) {
      await this.mail.send(
        inbox,
        `Support #${r.number}: ${r.subject}`,
        `From: ${r.name} <${r.email}>\nSchool: ${r.schoolName ?? '—'}\n\n${r.message}\n\nReply to the parent at ${r.email}.`,
      );
    } else this.log.warn(`SUPPORT_EMAIL not set — request #${r.number} saved but nobody was emailed.`);
    return { number: r.number };
  }
}

@Module({ controllers: [SupportController], providers: [MailService] })
export class SupportModule {}
