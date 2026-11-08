import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // SIGTERM/SIGINT fecham os workers com calma
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
