import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAILER, Mailer } from './mailer.interface';

@Injectable()
export class MailService {
  private readonly appUrl: string;

  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly config: ConfigService,
  ) {
    this.appUrl = this.config.get<string>('APP_URL') ?? 'http://localhost:3000';
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const verifyUrl = `${this.appUrl}/verify-email?token=${token}`;
    await this.mailer.sendVerification({ to, verifyUrl });
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    const resetUrl = `${this.appUrl}/reset-password?token=${token}`;
    await this.mailer.sendPasswordReset({ to, resetUrl });
  }

  async sendPasswordChangedEmail(to: string): Promise<void> {
    await this.mailer.sendPasswordChanged({ to });
  }

  async sendWelcomeEmail(to: string, firstName: string): Promise<void> {
    await this.mailer.sendWelcome({ to, firstName });
  }

  async sendTrainerInviteEmail(to: string, firstName: string, setupToken: string): Promise<void> {
    const setupUrl = `${this.appUrl}/setup?token=${setupToken}`;
    await this.mailer.sendTrainerInvite({ to, firstName, setupUrl });
  }

  async sendJoinConfirmationEmail(to: string, trainerName: string): Promise<void> {
    await this.mailer.sendJoinConfirmation({ to, trainerName });
  }

  async sendCoachInviteEmail(
    to: string,
    trainerName: string,
    acceptToken: string,
    message?: string,
  ): Promise<void> {
    const acceptUrl = `${this.appUrl}/coach-invite?token=${acceptToken}`;
    await this.mailer.sendCoachInvite({ to, trainerName, acceptUrl, message });
  }

  /**
   * "[Child Name] wants to join [Trainer Name]'s program", carrying
   * the ShareLink so the parent can finish the registration themselves.
   */
  async sendChildJoinRequestEmail(
    to: string,
    input: { childName: string; trainerName: string; code: string },
  ): Promise<void> {
    const joinUrl = `${this.appUrl}/join/${input.code}`;
    await this.mailer.sendChildJoinRequest({
      to,
      childName: input.childName,
      trainerName: input.trainerName,
      joinUrl,
    });
  }

  /** The coach is told when a trainer schedules over their My Times. */
  async sendCoachAvailabilityOverrideEmail(
    to: string,
    input: {
      trainerName: string;
      dayName: string;
      startTime: string;
      endTime: string;
      reason: string;
    },
  ): Promise<void> {
    await this.mailer.sendCoachAvailabilityOverride({ to, ...input });
  }
}
