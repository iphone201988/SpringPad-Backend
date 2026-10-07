import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true }); // rawBody: Stripe webhook signatures
  app.use(helmet());
  // The Next.js server calls us and forwards the visitor's IP; trust X-Forwarded-For only from it
  // (loopback locally — set TRUST_PROXY to the storefront's address/hops in production).
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean), credentials: true });
  // Reject unknown fields and validate every request body against its DTO.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(process.env.PORT ?? 3001);
}
await bootstrap();
