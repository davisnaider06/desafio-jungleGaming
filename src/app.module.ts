import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import config from './mikro-orm.config';
import { HealthController } from './health/health.controller';

@Module({
  imports: [MikroOrmModule.forRoot(config)],
  controllers: [HealthController],
})
export class AppModule {}
