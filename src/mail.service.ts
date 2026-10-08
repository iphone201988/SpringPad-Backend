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
          html: html ?? brandedHtml(subject, text),
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


const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Wraps a plain-text email in the Springpad layout. Paragraphs come from blank lines;
 * a line that is just a URL becomes a button. Inline styles + tables: what email clients support.
 */
export function brandedHtml(subject: string, text: string) {
  const body = text
    .trim()
    .split(/\n\s*\n/)
    .map((para) => {
      const lines = para.split('\n');
      return lines
        .map((line) => {
          const url = line.trim();
          if (/^https?:\/\/\S+$/.test(url))
            return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px"><tr><td style="border-radius:10px;background:#f6c94a"><a href="${esc(url)}" style="display:inline-block;padding:12px 24px;font-weight:600;font-size:15px;color:#26312c;text-decoration:none">${esc(buttonLabel(subject))}</a></td></tr></table><p style="margin:12px 0 0;font-size:12px;color:#6b716f;word-break:break-all">Or paste this link into your browser:<br><a href="${esc(url)}" style="color:#477c05">${esc(url)}</a></p>`;
          return `<p style="margin:0 0 4px">${esc(line).replace(/(https?:\/\/\S+)/g, '<a href="$1" style="color:#477c05">$1</a>')}</p>`;
        })
        .join('');
    })
    .map((block) => `<div style="margin:0 0 16px">${block}</div>`)
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#fff8e8;font-family:Poppins,Helvetica,Arial,sans-serif;color:#26312c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff8e8;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 20px;font-size:24px;font-weight:700;color:#24483a">springpad</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e9eaea;border-radius:16px;padding:32px;font-size:15px;line-height:1.6">
<h1 style="margin:0 0 20px;font-family:Georgia,serif;font-size:22px;font-weight:600;color:#24483a">${esc(subject)}</h1>
${body}
</td></tr>
<tr><td style="padding:20px 4px 0;font-size:12px;color:#6b716f;text-align:center">Springpad · School photos, kept for life.<br>You received this email because of activity on your Springpad account.</td></tr>
</table></td></tr></table></body></html>`;
}

// Button text from the subject, e.g. "Verify your Springpad account" → "Verify your account".
function buttonLabel(subject: string) {
  const s = subject.toLowerCase();
  if (s.includes('verify') || s.includes('confirm')) return 'Confirm my email';
  if (s.includes('reset')) return 'Reset my password';
  if (s.includes('invit')) return 'Accept invitation';
  if (s.includes('password')) return 'Set my password';
  if (s.includes('order') || s.includes('receipt')) return 'View my order';
  return 'Open Springpad';
}
