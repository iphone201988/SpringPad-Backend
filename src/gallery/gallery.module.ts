import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { GalleryController, MediaController } from './gallery.controller.js';
import { GalleryService } from './gallery.service.js';

@Module({
  imports: [AuthModule],
  controllers: [GalleryController, MediaController],
  providers: [GalleryService],
})
export class GalleryModule {}
