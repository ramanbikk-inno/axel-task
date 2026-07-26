import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ImpersonationLogService } from './impersonation-log.service';
import { ImpersonationLog } from './entities/impersonation-log.entity';

/**
 * The impersonation audit trail on its own, with no dependency on AuthModule.
 *
 * ImpersonationModule imports AuthModule, so AuthModule cannot import it back —
 * but the paths that end a session (logout, bulk revocation) live in AuthModule
 * and have to close the log. Keeping the writer in a leaf module lets both use
 * it without a cycle.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ImpersonationLog])],
  providers: [ImpersonationLogService],
  exports: [ImpersonationLogService],
})
export class ImpersonationLogModule {}
