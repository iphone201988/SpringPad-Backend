import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service.js';
import { signedUrl } from './media.js';

// Every query here is filtered by an ACTIVE parent_child_link for the caller (brief §5).
// "Not linked" and "doesn't exist" both return 404, so ids can't be probed.
const activeLink = (customerId: string) => ({ links: { some: { customerId, status: 'ACTIVE' as const } } });

@Injectable()
export class GalleryService {
  constructor(private readonly db: PrismaService) {}

  private present(img: { id: string; reference: string; width: number; height: number; shoot: { name: string; takenOn: Date } | null; favourites: unknown[] }) {
    return {
      id: img.id,
      reference: img.reference,
      width: img.width,
      height: img.height,
      shoot: img.shoot,
      favourite: img.favourites.length > 0,
      thumbUrl: signedUrl(img.id, 'thumb'),
      previewUrl: signedUrl(img.id, 'preview'),
    };
  }

  private select(customerId: string) {
    return {
      id: true,
      reference: true,
      width: true,
      height: true,
      shoot: { select: { name: true, takenOn: true } },
      favourites: { where: { customerId }, select: { imageId: true } },
    } as const;
  }

  async childImages(customerId: string, childId: string) {
    const child = await this.db.child.findFirst({ where: { id: childId, ...activeLink(customerId) }, select: { id: true } });
    if (!child) throw new NotFoundException();
    const images = await this.db.imageAsset.findMany({
      where: { childId, isAnchor: false }, // anchor shots (child holding the code card) are never shown
      orderBy: [{ capturedAt: 'asc' }, { reference: 'asc' }],
      select: this.select(customerId),
    });
    return images.map((i) => this.present(i));
  }

  async image(customerId: string, imageId: string) {
    const img = await this.db.imageAsset.findFirst({
      where: { id: imageId, isAnchor: false, child: activeLink(customerId) },
      select: { ...this.select(customerId), child: { select: { id: true, firstName: true, lastName: true } } },
    });
    if (!img) throw new NotFoundException();
    return { ...this.present(img), child: img.child };
  }

  async setFavourite(customerId: string, imageId: string, on: boolean) {
    await this.image(customerId, imageId); // access check
    if (on) await this.db.favourite.upsert({ where: { customerId_imageId: { customerId, imageId } }, create: { customerId, imageId }, update: {} });
    else await this.db.favourite.deleteMany({ where: { customerId, imageId } });
  }

  async favourites(customerId: string) {
    const images = await this.db.imageAsset.findMany({
      // re-check the link: if access was revoked, old favourites disappear too
      where: { isAnchor: false, favourites: { some: { customerId } }, child: activeLink(customerId) },
      orderBy: { createdAt: 'desc' },
      select: { ...this.select(customerId), child: { select: { id: true, firstName: true, lastName: true } } },
    });
    return images.map((i) => ({ ...this.present(i), child: i.child }));
  }

  /** For the media endpoint: master key of a non-anchor image (signature already verified). */
  masterKey(imageId: string) {
    return this.db.imageAsset.findFirst({ where: { id: imageId, isAnchor: false }, select: { masterKey: true } });
  }
}
