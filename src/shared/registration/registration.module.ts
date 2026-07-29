import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AgeGateService } from './age-gate.service';

@Module({
  imports: [ConfigModule],
  providers: [AgeGateService],
  exports: [AgeGateService],
})
export class RegistrationModule {}
