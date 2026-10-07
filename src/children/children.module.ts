import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MailService } from '../mail.service.js';
import { ChildrenController } from './children.controller.js';
import { ChildrenService } from './children.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ChildrenController],
  providers: [ChildrenService, MailService],
})
export class ChildrenModule {}
