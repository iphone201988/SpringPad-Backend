import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';
import exifReader from 'exif-reader';
import type { Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { hashChildCode, normalizeChildCode } from '../../children/linking.js';
import { masterPath } from '../../gallery/media.js';
import { PrismaService } from '../../prisma.service.js';
import { CurrentStaff, StaffGuard, type Staff } from '../staff-auth.js';
import { decodeCard, lookalikeVariants } from './decode.js';
import { captureOrder, matchShoot, publishable } from './match.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class ShootDto {
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsDateString() takenOn: string;
  @Matches(/^\d{4}-\d{2}$/) academicYear: string;
}

class UploadMetaDto {
  /** The browser's file modified time, used when the photo has no camera EXIF time. */
  @IsOptional() @IsDateString() lastModified?: string;
}

class PhotoPatchDto {
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID() overrideChildId?: string | null;
  @IsOptional() @IsBoolean() overrideNotAnchor?: boolean;
  @IsOptional() @IsBoolean() excluded?: boolean;
  @IsOptional() @IsBoolean() runApproved?: boolean;
}

const mediaRoot = () => path.resolve(process.env.MEDIA_DIR ?? 'storage');

@Controller('admin')
@UseGuards(StaffGuard)
export class ShootsController {
  constructor(private readonly db: PrismaService) {}

  @Get('schools/:id/shoots')
  shoots(@Param('id', ParseUUIDPipe) schoolId: string) {
    return this.db.shoot.findMany({
      where: { schoolId },
      orderBy: { takenOn: 'desc' },
      select: { id: true, name: true, academicYear: true, takenOn: true, _count: { select: { photos: true, images: true } } },
    });
  }

  @Post('schools/:id/shoots')
  async createShoot(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) schoolId: string, @Body() dto: ShootDto) {
    if (!(await this.db.school.findUnique({ where: { id: schoolId } }))) throw new NotFoundException();
    const s = await this.db.shoot.create({ data: { schoolId, name: dto.name, academicYear: dto.academicYear, takenOn: new Date(dto.takenOn) } });
    await this.db.auditLog.create({ data: { action: 'SHOOT_CREATED', staffId: me.id, detail: { shootId: s.id } } });
    return { id: s.id };
  }

  /** Children enrolled that academic year at the shoot's school, with the status of their card code for this shoot. */
  @Get('shoots/:id/roster')
  async roster(@Param('id', ParseUUIDPipe) id: string) {
    const shoot = await this.db.shoot.findUnique({ where: { id }, select: { schoolId: true, academicYear: true } });
    if (!shoot) throw new NotFoundException();
    const children = await this.db.child.findMany({
      where: { schoolId: shoot.schoolId, enrolments: { some: { academicYear: shoot.academicYear } } },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        enrolments: { where: { academicYear: shoot.academicYear }, select: { className: true } },
        codes: { where: { shootId: id }, orderBy: { createdAt: 'desc' }, take: 1, select: { redeemedAt: true, expiresAt: true } },
      },
    });
    const now = new Date();
    return children.map((c) => {
      const k = c.codes[0];
      return {
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        className: c.enrolments[0]?.className ?? null,
        code: !k ? 'NONE' : k.redeemedAt ? 'REDEEMED' : k.expiresAt && k.expiresAt <= now ? 'REVOKED' : 'ISSUED',
      };
    });
  }

  /** One photo per request (the admin page uploads several in parallel). Card reading happens here. */
  @Post('shoots/:id/photos') @SkipThrottle()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 60 * 1024 * 1024, files: 1 } }))
  async upload(@Param('id', ParseUUIDPipe) shootId: string, @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined, @Body() meta: UploadMetaDto) {
    const shoot = await this.db.shoot.findUnique({ where: { id: shootId }, select: { id: true, schoolId: true } });
    if (!shoot) throw new NotFoundException();
    if (!file) throw new BadRequestException('No file.');
    const info = await sharp(file.buffer).metadata().catch(() => null);
    if (!info || !['jpeg', 'png', 'heif', 'tiff', 'webp'].includes(info.format ?? '') || !info.width || !info.height) {
      throw new BadRequestException(`${file.originalname} isn’t a photo we can read.`);
    }
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const dupe = await this.db.shootPhoto.findUnique({ where: { shootId_sha256: { shootId, sha256 } }, select: { id: true } });
    if (dupe) return { id: dupe.id, duplicate: true };

    const id = randomUUID();
    const masterKey = `shoots/${shootId}/${id}.${info.format === 'jpeg' ? 'jpg' : info.format}`;
    await mkdir(path.dirname(masterPath(masterKey)), { recursive: true });
    await writeFile(masterPath(masterKey), file.buffer);

    const decoded = await decodeCard(file.buffer);
    // Strict, as the brief asks: only codes issued for this shoot count; a card from another photo day is "unknown".
    // QR reads are exact. OCR reads also try look-alike characters (8/B, Z/2, Q/0…) against this shoot's codes.
    const guesses = decoded.kind === 'QR' ? [decoded.text] : decoded.kind === 'OCR' ? [...new Set(decoded.candidates.flatMap((c) => lookalikeVariants(c)))] : [];
    const match = guesses.length
      ? await this.db.childCode.findFirst({ where: { shootId: shoot.id, codeHash: { in: guesses.map(hashChildCode) } }, select: { childId: true } })
      : null;
    const decodedChildId = match?.childId ?? null;
    // A QR that holds something code-shaped but not this shoot's is an "unknown code"; a QR with other content
    // (a poster, a phone screen) is just a photo.
    const decodedUnknown = !decodedChildId && decoded.kind === 'QR' && normalizeChildCode(decoded.text).length === 12;
    // A card we could see but not match must never pass silently as a portrait (it would join the previous child's run).
    const decodeKind = decodedChildId ? decoded.kind : decodedUnknown ? 'QR' : decoded.kind === 'OCR' || decoded.kind === 'UNREADABLE' ? 'UNREADABLE' : 'NONE';
    const rotated = (info.orientation ?? 1) >= 5; // EXIF says the camera was on its side
    await this.db.shootPhoto.create({
      data: {
        id,
        shootId,
        masterKey,
        filename: file.originalname.slice(0, 200),
        sha256,
        width: rotated ? info.height : info.width,
        height: rotated ? info.width : info.height,
        capturedAt: exifTime(info.exif) ?? (meta.lastModified ? new Date(meta.lastModified) : null),
        decodeKind,
        decodedChildId,
        decodedUnknown,
      },
    });
    return { id, card: !!decodedChildId || decodedUnknown || decoded.kind === 'UNREADABLE' };
  }

  /** The shoot as staff review it: runs (card photo + that child's photos) with anything that needs a look flagged. */
  @Get('shoots/:id')
  async shoot(@Param('id', ParseUUIDPipe) id: string) {
    const shoot = await this.db.shoot.findUnique({ where: { id }, select: { id: true, name: true, academicYear: true, takenOn: true, school: { select: { id: true, name: true } } } });
    if (!shoot) throw new NotFoundException();
    const photos = await this.db.shootPhoto.findMany({ where: { shootId: id } });
    const runs = matchShoot(photos);
    const childIds = [...new Set(runs.flatMap((r) => (r.childId ? [r.childId] : [])))];
    const children = await this.db.child.findMany({ where: { id: { in: childIds } }, select: { id: true, firstName: true, lastName: true } });
    const byId = new Map(photos.map((p) => [p.id, p]));
    const view = (pid: string) => {
      const p = byId.get(pid)!;
      return { id: p.id, filename: p.filename, capturedAt: p.capturedAt, published: !!p.imageId };
    };
    return {
      shoot,
      counts: { photos: photos.length, excluded: photos.filter((p) => p.excluded).length, published: photos.filter((p) => p.imageId).length },
      excluded: photos.filter((p) => p.excluded).map((p) => view(p.id)),
      runs: runs.map((r) => {
        const c = children.find((c) => c.id === r.childId);
        return {
          ...r,
          child: c ? { id: c.id, name: `${c.firstName} ${c.lastName}` } : null,
          anchor: r.anchorId ? view(r.anchorId) : null,
          photos: r.photoIds.map(view),
          publishable: publishable(r),
        };
      }),
    };
  }

  /** Staff corrections. Published photos are locked so nothing already visible to a parent moves child silently. */
  @Patch('photos/:id')
  async patchPhoto(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PhotoPatchDto) {
    const p = await this.db.shootPhoto.findUnique({ where: { id }, include: { shoot: { select: { schoolId: true } } } });
    if (!p) throw new NotFoundException();
    if (p.imageId && (dto.overrideChildId !== undefined || dto.overrideNotAnchor !== undefined || dto.excluded !== undefined)) {
      throw new ConflictException('This photo is already published to parents, so it can’t be moved.');
    }
    if (dto.overrideChildId) {
      const child = await this.db.child.findUnique({ where: { id: dto.overrideChildId }, select: { schoolId: true } });
      if (child?.schoolId !== p.shoot.schoolId) throw new BadRequestException('That child isn’t at this school.');
    }
    const data = { ...dto, ...(dto.overrideChildId && { overrideNotAnchor: false }), ...(dto.overrideNotAnchor && { overrideChildId: null }) };
    await this.db.shootPhoto.update({ where: { id }, data });
    await this.db.auditLog.create({ data: { action: 'SHOOT_PHOTO_CORRECTED', staffId: me.id, childId: dto.overrideChildId ?? null, detail: { photoId: id, ...dto } } });
    return { ok: true };
  }

  /** Sends every publishable run to parents' galleries. Flagged runs wait. Safe to run again. */
  @Post('shoots/:id/publish') @HttpCode(200)
  async publish(@CurrentStaff() me: Staff, @Param('id', ParseUUIDPipe) id: string) {
    const shoot = await this.db.shoot.findUnique({ where: { id } });
    if (!shoot) throw new NotFoundException();
    const photos = await this.db.shootPhoto.findMany({ where: { shootId: id } });
    const byId = new Map(photos.map((p) => [p.id, p]));
    const order = new Map([...photos].sort(captureOrder).map((p, i) => [p.id, i + 1]));
    let published = 0;
    for (const run of matchShoot(photos).filter(publishable)) {
      for (const [pid, isAnchor] of [[run.anchorId!, true], ...run.photoIds.map((p) => [p, false])] as [string, boolean][]) {
        const p = byId.get(pid)!;
        if (p.imageId) continue;
        await this.db.$transaction(async (tx) => {
          const img = await tx.imageAsset.create({
            data: {
              childId: run.childId!,
              shootId: id,
              reference: `${shoot.academicYear.slice(0, 4)}-${String(order.get(pid)).padStart(4, '0')}`,
              isAnchor, // card photos are kept but never shown to parents
              masterKey: p.masterKey,
              width: p.width,
              height: p.height,
              capturedAt: p.capturedAt,
              rights: { licence: 'school-portrait', printable: true },
            },
          });
          await tx.shootPhoto.update({ where: { id: pid }, data: { imageId: img.id } });
        });
        if (!isAnchor) published++;
      }
    }
    await this.db.auditLog.create({ data: { action: 'SHOOT_PUBLISHED', staffId: me.id, detail: { shootId: id, published } } });
    return { published };
  }

  /** Small preview for the review screen (staff only; parents never get shoot photos this way). */
  @Get('photos/:id/thumb') @SkipThrottle()
  async thumb(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const p = await this.db.shootPhoto.findUnique({ where: { id }, select: { masterKey: true } });
    if (!p) throw new NotFoundException();
    const out = path.join(mediaRoot(), 'derived', 'admin', `${id}.webp`);
    try {
      await stat(out);
    } catch {
      await mkdir(path.dirname(out), { recursive: true });
      await sharp(masterPath(p.masterKey)).rotate().resize({ width: 360, height: 360, fit: 'inside' }).webp({ quality: 70 }).toFile(out);
    }
    res.set({ 'content-type': 'image/webp', 'cache-control': 'private, max-age=3600' }).send(await readFile(out));
  }
}

function exifTime(exif?: Buffer) {
  if (!exif) return null;
  try {
    const t = exifReader(exif).Photo?.DateTimeOriginal;
    return t instanceof Date && !Number.isNaN(t.getTime()) ? t : null;
  } catch {
    return null;
  }
}
