import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CatalogModule } from '../catalog.js';
import { MailService } from '../mail.service.js';
import { ShopController, StripeWebhookController } from './shop.controller.js';
import { ShopService } from './shop.service.js';

@Module({
  imports: [AuthModule, CatalogModule],
  controllers: [ShopController, StripeWebhookController],
  providers: [ShopService, MailService],
})
export class ShopModule {}
