import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AddressModule } from './addresses.js';
import { AdminModule } from './admin/admin.module.js';
import { AppController } from './app.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog.js';
import { ChildrenModule } from './children/children.module.js';
import { GalleryModule } from './gallery/gallery.module.js';
import { PrismaModule } from './prisma.service.js';
import { ShopModule } from './shop/shop.module.js';
import { SupportModule } from './support.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Default: 100 requests / minute / client IP. Auth endpoints tighten this with @Throttle.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    AuthModule,
    ChildrenModule,
    GalleryModule,
    ShopModule,
    AddressModule,
    CatalogModule,
    SupportModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
