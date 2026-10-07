import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly log = new Logger('Mail');
  private transporter: Transporter | null = null;
  private cachedUser?: string;
  private cachedPass?: string;

  private getTransporter(): Transporter | null {
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS?.replace(/\s+/g, '');
    if (!user || !pass) return null;

    if (!this.transporter || this.cachedUser !== user || this.cachedPass !== pass) {
      this.cachedUser = user;
      this.cachedPass = pass;
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass },
      });
      this.log.log(`Gmail SMTP configured for ${user}`);
    }
    return this.transporter;
  }

  async send(to: string, subject: string, text: string, html?: string) {
    // 1. Always record in tmp/mail for local inspection and automated tests
    const dir = path.join(process.cwd(), 'tmp', 'mail');
    await mkdir(dir, { recursive: true });
    const file = path.join(
      dir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}_${subject.replace(/\W+/g, '-')}_${randomUUID().slice(0, 8)}.txt`,
    );
    await writeFile(file, `To: ${to}\nSubject: ${subject}\n\n${text}\n`);

    // 2. If Gmail SMTP is configured, send the real email (skip example.com test addresses)
    const transporter = this.getTransporter();
    if (transporter && !to.endsWith('@example.com')) {
      try {
        const from = process.env.SMTP_FROM?.trim() || `"Springpad" <${process.env.SMTP_USER}>`;
        await transporter.sendMail({
          from,
          to,
          subject,
          text,
          ...(html && { html }),
        });
        this.log.log(`"${subject}" → ${to} sent via Gmail SMTP`);
        return;
      } catch (err) {
        this.log.error(`Failed to send email to ${to} via Gmail SMTP: ${(err as Error).message}`);
      }
    }

    this.log.log(`"${subject}" → ${to} (saved to ${path.relative(process.cwd(), file)})`);
  }
}

