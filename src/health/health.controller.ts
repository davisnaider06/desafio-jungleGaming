import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /** Liveness: o processo está de pé. Não toca em dependências externas. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }
}
