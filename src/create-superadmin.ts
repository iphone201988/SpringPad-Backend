// First admin account (after that, superadmins invite staff from /admin/staff).
// Run: npm run admin:create -- you@example.com "Your Name"   → prints and emails a set-password link.
import 'dotenv/config';
import { StaffAuthService } from './admin/staff-auth.js';
import { MailService } from './mail.service.js';
import { PrismaService } from './prisma.service.js';

const [email, name] = process.argv.slice(2);
if (!email?.includes('@') || !name) {
  console.error('Usage: npm run admin:create -- <email> "<name>"');
  process.exit(1);
}
const db = new PrismaService();
const staff = await db.staffUser.upsert({ where: { email: email.toLowerCase() }, create: { email: email.toLowerCase(), name, role: 'SUPERADMIN' }, update: { role: 'SUPERADMIN', active: true } });
const link = await new StaffAuthService(db, new MailService()).issueInvite(staff.id);
console.log(`Superadmin ${staff.email} — set a password here (valid 3 days):\n${link}`);
await db.$disconnect();
