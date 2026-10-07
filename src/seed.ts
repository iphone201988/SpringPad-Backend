// Demo data until the admin panel / photo ingestion exist: a school, a shoot, two siblings with photos,
// and one single-use code each. Run: npm run seed:demo  (prints the codes once — only hashes are stored)
import 'dotenv/config';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { generateChildCode, hashChildCode } from './children/linking.js';
import { masterPath } from './gallery/media.js';
import { PrismaService } from './prisma.service.js';

// Sample photos from the Figma export stand in for real shoot images.
const samples = path.resolve('../frontend/public/images');
const photos: Record<string, string[]> = {
  Emma: ['portrait-emma.png', 'avatars/5.png', 'avatars/4.png', 'step-choose.jpg'],
  Leo: ['avatars/6.png', 'avatars/3.png', 'avatars/9.png'],
};

const db = new PrismaService();
const school = await db.school.create({ data: { name: 'Greenwood Primary School' } });
const shoot = await db.shoot.create({
  data: { schoolId: school.id, name: 'Autumn Portraits 2026', academicYear: '2026-27', takenOn: new Date('2026-09-18') },
});

let ref = 1;
for (const [firstName, className] of [['Emma', 'Year 2 Oak'], ['Leo', 'Reception Willow']]) {
  const child = await db.child.create({
    data: { schoolId: school.id, firstName, lastName: 'Smith', enrolments: { create: { academicYear: '2026-27', className } } },
  });

  // First shot of each child is the anchor (holding their code card) — stored, but never shown to parents.
  for (const [i, file] of [photos[firstName][0], ...photos[firstName]].entries()) {
    const key = `${shoot.id}/${child.id}/${i}${path.extname(file)}`;
    await mkdir(path.dirname(masterPath(key)), { recursive: true });
    await copyFile(path.join(samples, file), masterPath(key));
    const { width = 0, height = 0 } = await sharp(masterPath(key)).metadata();
    await db.imageAsset.create({
      data: {
        childId: child.id,
        shootId: shoot.id,
        reference: i === 0 ? 'ANCHOR' : `2026-${String(ref++).padStart(3, '0')}`,
        isAnchor: i === 0,
        masterKey: key,
        width,
        height,
        rights: { licence: 'school-portrait', printable: true },
        capturedAt: new Date(Date.UTC(2026, 8, 18, 9, i)),
      },
    });
  }

  const code = generateChildCode();
  await db.childCode.create({ data: { childId: child.id, codeHash: hashChildCode(code) } });
  console.log(`${firstName} Smith (${className}, ${photos[firstName].length} photos) → code ${code}`);
}

// Demo promo codes (create real ones with SQL until there is an admin screen).
for (const p of [
  { code: 'SPRING10', percentOff: 10 },
  { code: 'WELCOME5', amountOffPence: 500, minSubtotalPence: 2000 },
]) await db.promoCode.upsert({ where: { code: p.code }, create: p, update: {} });
console.log('Promo codes: SPRING10 (10% off), WELCOME5 (£5 off £20+)');
await db.$disconnect();
