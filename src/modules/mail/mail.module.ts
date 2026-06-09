import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MAILER } from './mailer.interface';
import { ResendMailer } from './resend.mailer';
import { MailService } from './mail.service';

@Module({
  imports: [ConfigModule],
  providers: [{ provide: MAILER, useClass: ResendMailer }, MailService],
  exports: [MailService, MAILER],
})
export class MailModule {}
