import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { Mailer } from './mailer.interface';

@Injectable()
export class ResendMailer implements Mailer {
  private readonly logger = new Logger(ResendMailer.name);
  private readonly client: Resend;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.client = new Resend(this.config.get<string>('RESEND_API_KEY') || undefined);
    this.from = this.config.get<string>('MAIL_FROM') ?? 'no-reply@axel.test';
  }

  async sendVerification(input: { to: string; verifyUrl: string }): Promise<void> {
    await this.send(
      input.to,
      'Verify your email',
      `<p>Confirm your email by visiting <a href="${input.verifyUrl}">this link</a>.</p>`,
    );
  }

  async sendPasswordReset(input: { to: string; resetUrl: string }): Promise<void> {
    await this.send(
      input.to,
      'Reset your password',
      `<p>Reset your password using <a href="${input.resetUrl}">this link</a>.</p>`,
    );
  }

  async sendPasswordChanged(input: { to: string }): Promise<void> {
    await this.send(
      input.to,
      'Your password was changed',
      `<p>Your password was just changed. If this was not you, contact support.</p>`,
    );
  }

  async sendWelcome(input: { to: string; firstName: string }): Promise<void> {
    await this.send(input.to, 'Welcome to Axel', `<p>Welcome aboard, ${input.firstName}!</p>`);
  }

  async sendTrainerInvite(input: {
    to: string;
    firstName: string;
    setupUrl: string;
  }): Promise<void> {
    await this.send(
      input.to,
      'Set up your trainer account',
      `<p>Hi ${input.firstName}, set up your account via <a href="${input.setupUrl}">this link</a>.</p>`,
    );
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      subject,
      html,
    });
    if (error) {
      this.logger.error(`Failed to send "${subject}" to ${to}: ${error.message}`);
      throw new Error(`Mail send failed: ${error.message}`);
    }
  }
}
