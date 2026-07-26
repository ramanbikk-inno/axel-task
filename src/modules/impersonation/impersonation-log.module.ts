import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ImpersonationLogService } from './impersonation-log.service';
import { ImpersonationLog } from './entities/impersonation-log.entity';

/**
 * Leaf module: ImpersonationModule imports AuthModule, so AuthModule cannot
 * import it back — but logout and bulk revocation live there and have to close
 * the log. Keeping the writer here lets both use it without a cycle.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ImpersonationLog])],
  providers: [ImpersonationLogService],
  exports: [ImpersonationLogService],
})
export class ImpersonationLogModule {}
