import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { ErrorCode } from '../../shared/errors/error-codes';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../mail/mail.service';
import { Role, UserStatus } from '../users/entities/user.enums';
import { UsersService } from '../users/users.service';
import { TrainersService } from '../trainers/trainers.service';
import { CreateTrainerDto } from './dto/create-trainer.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly usersService: UsersService,
    private readonly trainersService: TrainersService,
    private readonly authService: AuthService,
    private readonly mail: MailService,
  ) {}

  async createTrainer(input: CreateTrainerDto): Promise<{ id: string; email: string; role: Role }> {
    if (input.role !== undefined && input.role === Role.SuperAdmin) {
      throw new ForbiddenException({
        errorCode: ErrorCode.CANNOT_CREATE_SUPER_ADMIN,
        message: 'A Super Admin cannot be created through this endpoint.',
      });
    }

    const existing = await this.usersService.findByEmail(input.email);
    if (existing !== null) {
      throw new ConflictException({
        errorCode: ErrorCode.EMAIL_ALREADY_EXISTS,
        message: 'An account with this email already exists.',
      });
    }

    let setupToken = '';
    const user = await this.dataSource.transaction(async (manager: EntityManager) => {
      const created = await this.usersService.create(
        {
          email: input.email,
          role: Role.Trainer,
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          emailVerified: false,
          mustSetPassword: true,
          status: UserStatus.Active,
        },
        manager,
      );

      await this.trainersService.create(
        { userId: created.id, businessName: input.businessName },
        manager,
      );

      setupToken = await this.authService.createSetupToken(created.id, manager);

      return created;
    });

    await this.mail.sendTrainerInviteEmail(user.email, input.firstName ?? '', setupToken);

    return { id: user.id, email: user.email, role: Role.Trainer };
  }
}
