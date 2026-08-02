import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { escapeHtml } from './escape-html';
import { Mailer } from './mailer.interface';

@Injectable()
export class ResendMailer implements Mailer {
  private readonly logger = new Logger(ResendMailer.name);
  private client: Resend | null = null;
  private readonly apiKey: string;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('RESEND_API_KEY') ?? '';
    this.from = this.config.get<string>('MAIL_FROM') ?? 'no-reply@axel.test';
  }

  private getClient(): Resend {
    if (!this.apiKey) {
      throw new Error('RESEND_API_KEY is not configured; cannot send email.');
    }
    if (!this.client) {
      this.client = new Resend(this.apiKey);
    }
    return this.client;
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
    await this.send(
      input.to,
      'Welcome to Axel',
      `<p>Welcome aboard, ${escapeHtml(input.firstName)}!</p>`,
    );
  }

  async sendTrainerInvite(input: {
    to: string;
    firstName: string;
    setupUrl: string;
  }): Promise<void> {
    await this.send(
      input.to,
      'Set up your trainer account',
      `<p>Hi ${escapeHtml(input.firstName)}, set up your account via <a href="${input.setupUrl}">this link</a>.</p>`,
    );
  }

  async sendJoinConfirmation(input: { to: string; trainerName: string }): Promise<void> {
    const trainerName = escapeHtml(input.trainerName);
    await this.send(
      input.to,
      `You joined ${input.trainerName}`,
      `<p>You are now connected with ${trainerName}. You can see their events and content once your email is verified.</p>`,
    );
  }

  async sendCoachInvite(input: {
    to: string;
    trainerName: string;
    acceptUrl: string;
    message?: string;
  }): Promise<void> {
    const note = input.message ? `<p>${escapeHtml(input.message)}</p>` : '';
    await this.send(
      input.to,
      `${input.trainerName} invited you to coach`,
      `${note}<p>Accept your coaching invitation via <a href="${input.acceptUrl}">this link</a> (expires in 7 days).</p>`,
    );
  }

  async sendChildJoinRequest(input: {
    to: string;
    childName: string;
    trainerName: string;
    joinUrl: string;
  }): Promise<void> {
    const childName = escapeHtml(input.childName);
    const trainerName = escapeHtml(input.trainerName);
    await this.send(
      input.to,
      `${input.childName} wants to join ${input.trainerName}'s program`,
      `<p>${childName} opened a registration link for ${trainerName}. ` +
        `Children cannot add trainers themselves, so nothing has changed yet.</p>` +
        `<p><a href="${input.joinUrl}">Review registration</a></p>`,
    );
  }

  async sendCoachAvailabilityOverride(input: {
    to: string;
    trainerName: string;
    dayName: string;
    startTime: string;
    endTime: string;
    reason: string;
  }): Promise<void> {
    const trainerName = escapeHtml(input.trainerName);
    await this.send(
      input.to,
      'You were scheduled outside your availability',
      `<p>${trainerName} scheduled you on ${input.dayName} from ${input.startTime} to ${input.endTime}, which falls outside the availability you set.</p>` +
        `<p>Reason given: ${escapeHtml(input.reason)}</p>` +
        `<p>You are not blocked from this session — contact your trainer if you need the assignment changed.</p>`,
    );
  }

  async sendPurchaseApprovalRequest(input: {
    to: string;
    childName: string;
    eventTitle: string;
    amountLabel: string;
    expiresAt: string;
  }): Promise<void> {
    const childName = escapeHtml(input.childName);
    await this.send(
      input.to,
      `${input.childName} needs your approval to book a session`,
      `<p>${childName} would like to book ${escapeHtml(input.eventTitle)} for ${escapeHtml(input.amountLabel)}.</p>` +
        `<p>Approve or decline it from your account. If nobody answers by ${escapeHtml(input.expiresAt)}, the request is declined automatically.</p>`,
    );
  }

  async sendChildPurchaseNotice(input: {
    to: string;
    childName: string;
    eventTitle: string;
    amountLabel: string;
  }): Promise<void> {
    const childName = escapeHtml(input.childName);
    await this.send(
      input.to,
      `${input.childName} booked a session with tokens`,
      `<p>${childName} booked ${escapeHtml(input.eventTitle)} for ${escapeHtml(input.amountLabel)}.</p>` +
        `<p>This is for your information only — you allow ${childName} to spend tokens without approval. You can change that in their profile settings.</p>`,
    );
  }

  async sendPurchaseDecision(input: {
    to: string;
    childName: string;
    eventTitle: string;
    decision: string;
    notes?: string;
  }): Promise<void> {
    const decided = input.decision === 'approved' ? 'approved' : 'not approved';
    await this.send(
      input.to,
      `Your request for ${input.eventTitle} was ${decided}`,
      `<p>Your request to book ${escapeHtml(input.eventTitle)} was ${escapeHtml(decided)}.</p>` +
        (input.notes ? `<p>Note from your parent: ${escapeHtml(input.notes)}</p>` : ''),
    );
  }

  async sendCampShareLink(input: {
    to: string;
    firstName: string;
    trainerName: string;
    joinUrl: string;
  }): Promise<void> {
    await this.send(
      input.to,
      `Finish signing up with ${input.trainerName}`,
      `<p>Hi ${escapeHtml(input.firstName)}, thanks for filling in the form.</p>` +
        `<p>When you are ready, <a href="${input.joinUrl}">create your account</a> to see ${escapeHtml(input.trainerName)}'s sessions.</p>`,
    );
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    const { error } = await this.getClient().emails.send({
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
