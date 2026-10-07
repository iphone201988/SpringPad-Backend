import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from './prisma.service.js';

@Controller()
export class AppController {
  constructor(private readonly db: PrismaService) {}

  // Liveness + DB check for hosting/monitoring.
  @Get('health') @SkipThrottle()
  async health() {
    await this.db.$queryRaw`SELECT 1`;
    return { ok: true };
  }
}
