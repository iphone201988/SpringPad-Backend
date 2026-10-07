import { Module } from '@nestjs/common';
import { MailService } from '../mail.service.js';
import { AdminController } from './admin.controller.js';
import { ShootsController } from './ingest/shoots.controller.js';
import { CatalogAdminController } from './catalog-admin.controller.js';
import { OrdersAdminController } from './orders.controller.js';
import { ReportsController } from './reports.controller.js';
import { StaffAuthController, StaffAuthService, StaffGuard } from './staff-auth.js';

@Module({
  controllers: [StaffAuthController, AdminController, ShootsController, OrdersAdminController, CatalogAdminController, ReportsController],
  providers: [StaffAuthService, StaffGuard, MailService],
})
export class AdminModule {}
