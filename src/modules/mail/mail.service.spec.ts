import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { MAILER, Mailer } from './mailer.interface';

describe('MailService (unit)', () => {
  let service: MailService;
  let mailer: jest.Mocked<Mailer>;

  const APP_URL = 'https://app.axel.test';

  beforeEach(async () => {
    mailer = {
      sendVerification: jest.fn().mockResolvedValue(undefined),
      sendPasswordReset: jest.fn().mockResolvedValue(undefined),
      sendPasswordChanged: jest.fn().mockResolvedValue(undefined),
      sendWelcome: jest.fn().mockResolvedValue(undefined),
      sendTrainerInvite: jest.fn().mockResolvedValue(undefined),
      sendJoinConfirmation: jest.fn().mockResolvedValue(undefined),
      sendCoachInvite: jest.fn().mockResolvedValue(undefined),
      sendChildJoinRequest: jest.fn().mockResolvedValue(undefined),
      sendCoachAvailabilityOverride: jest.fn().mockResolvedValue(undefined),
      sendPurchaseApprovalRequest: jest.fn().mockResolvedValue(undefined),
      sendChildPurchaseNotice: jest.fn().mockResolvedValue(undefined),
      sendPurchaseDecision: jest.fn().mockResolvedValue(undefined),
      sendCampShareLink: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        MailService,
        { provide: MAILER, useValue: mailer },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string): string | undefined => (key === 'APP_URL' ? APP_URL : undefined),
          },
        },
      ],
    }).compile();

    service = moduleRef.get<MailService>(MailService);
  });

  it('sendVerificationEmail builds a verifyUrl containing the token', async () => {
    await service.sendVerificationEmail('user@axel.test', 'tok-verify-123');

    expect(mailer.sendVerification).toHaveBeenCalledWith({
      to: 'user@axel.test',
      verifyUrl: `${APP_URL}/verify-email?token=tok-verify-123`,
    });
  });

  it('sendPasswordResetEmail builds a resetUrl containing the token', async () => {
    await service.sendPasswordResetEmail('user@axel.test', 'tok-reset-456');

    expect(mailer.sendPasswordReset).toHaveBeenCalledWith({
      to: 'user@axel.test',
      resetUrl: `${APP_URL}/reset-password?token=tok-reset-456`,
    });
  });

  it('sendTrainerInviteEmail builds a setupUrl containing the setup token', async () => {
    await service.sendTrainerInviteEmail('coach@axel.test', 'Ada', 'tok-setup-789');

    expect(mailer.sendTrainerInvite).toHaveBeenCalledWith({
      to: 'coach@axel.test',
      firstName: 'Ada',
      setupUrl: `${APP_URL}/setup?token=tok-setup-789`,
    });
  });

  it('sendPasswordChangedEmail forwards the recipient', async () => {
    await service.sendPasswordChangedEmail('user@axel.test');
    expect(mailer.sendPasswordChanged).toHaveBeenCalledWith({ to: 'user@axel.test' });
  });

  it('sendWelcomeEmail forwards recipient and firstName', async () => {
    await service.sendWelcomeEmail('user@axel.test', 'Ada');
    expect(mailer.sendWelcome).toHaveBeenCalledWith({
      to: 'user@axel.test',
      firstName: 'Ada',
    });
  });

  it('sendJoinConfirmationEmail forwards recipient and trainerName', async () => {
    await service.sendJoinConfirmationEmail('user@axel.test', 'Hoops Academy');
    expect(mailer.sendJoinConfirmation).toHaveBeenCalledWith({
      to: 'user@axel.test',
      trainerName: 'Hoops Academy',
    });
  });
});
