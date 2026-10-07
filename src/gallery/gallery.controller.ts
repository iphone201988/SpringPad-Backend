import { Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Put, Query, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AuthGuard, CurrentCustomer, type AuthedCustomer } from '../auth/auth.guard.js';
import { GalleryService } from './gallery.service.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { derivative, isVariant, masterPath, verifySignature } from './media.js';

const uuid = new ParseUUIDPipe();

@Controller()
@UseGuards(AuthGuard)
export class GalleryController {
  constructor(private readonly gallery: GalleryService) {}

  @Get('children/:id/images')
  childImages(@CurrentCustomer() c: AuthedCustomer, @Param('id', uuid) childId: string) {
    return this.gallery.childImages(c.id, childId);
  }

  @Get('images/:id')
  image(@CurrentCustomer() c: AuthedCustomer, @Param('id', uuid) id: string) {
    return this.gallery.image(c.id, id);
  }

  @Get('favourites')
  favourites(@CurrentCustomer() c: AuthedCustomer) {
    return this.gallery.favourites(c.id);
  }

  @Put('images/:id/favourite') @HttpCode(204)
  favourite(@CurrentCustomer() c: AuthedCustomer, @Param('id', uuid) id: string) {
    return this.gallery.setFavourite(c.id, id, true);
  }

  @Delete('images/:id/favourite') @HttpCode(204)
  unfavourite(@CurrentCustomer() c: AuthedCustomer, @Param('id', uuid) id: string) {
    return this.gallery.setFavourite(c.id, id, false);
  }
}

// Image bytes. No session here (an <img> can't send our bearer token): the signed, expiring URL is the permission,
// and it is only issued by the endpoints above after the parent_child_link check.
@Controller('media')
@SkipThrottle() // a gallery page loads many images; the signature already gates access
export class MediaController {
  constructor(private readonly gallery: GalleryService) {}

  @Get(':id/:variant')
  async get(@Param('id', uuid) id: string, @Param('variant') variant: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    if (!isVariant(variant) || typeof sig !== 'string' || !verifySignature(id, variant, Number(exp), sig)) throw new NotFoundException();
    const img = await this.gallery.masterKey(id);
    if (!img) throw new NotFoundException();
    const headers = {
      'Cache-Control': 'private, max-age=300', // matches the URL lifetime; never shared caches
      'Cross-Origin-Resource-Policy': 'cross-origin', // the site (another origin) displays these
    };
    if (variant === 'original') {
      // Full-resolution file for a paid download (the signature was issued from an entitlement).
      const ext = path.extname(img.masterKey).toLowerCase();
      res.set({ ...headers, 'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg', 'Content-Disposition': `attachment; filename="springpad-${id}${ext}"` });
      return res.send(await readFile(masterPath(img.masterKey)));
    }
    res.set({ ...headers, 'Content-Type': 'image/webp' }).send(await derivative(id, img.masterKey, variant));
  }
}
