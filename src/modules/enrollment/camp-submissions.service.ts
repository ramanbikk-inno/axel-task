import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { repoFor } from '../../shared/database/repo-for';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { Principal } from '../auth/principal';
import { MailService } from '../mail/mail.service';
import { TrainersService } from '../trainers/trainers.service';
import { UsersService } from '../users/users.service';
import {
  CampSubmissionPrefillView,
  CampSubmissionView,
  ConvertCampSubmissionDto,
  CreateCampSubmissionDto,
} from './dto/camp-submission.dto';
import { JoinRegisterDto } from './dto/join-register.dto';
import { CampSubmission } from './entities/camp-submission.entity';
import { ShareLinkType } from './entities/share-link.entity';
import { JoinResult, JoinService } from './join.service';
import { ShareLinksService } from './share-links.service';

export const AUDIT_CAMP_SUBMITTED = 'camp.submitted';
export const AUDIT_CAMP_CONVERTED = 'camp.converted';
export const AUDIT_CAMP_SHARE_LINK_SENT = 'camp.share-link-sent';

@Injectable()
export class CampSubmissionsService {
  constructor(
    @InjectRepository(CampSubmission)
    private readonly submissions: Repository<CampSubmission>,
    private readonly shareLinks: ShareLinksService,
    private readonly joinService: JoinService,
    private readonly trainersService: TrainersService,
    private readonly usersService: UsersService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Capture a camp or evaluation form. Public and keyed on the trainer's player
   * ShareLink code, so the submission is bound to whoever handed the form out.
   */
  async submit(code: string, dto: CreateCampSubmissionDto): Promise<CampSubmissionPrefillView> {
    const link = await this.shareLinks.findByCode(code);
    if (!link || link.type !== ShareLinkType.PlayerStatic || !link.active) {
      throw new NotFoundException({
        errorCode: ErrorCode.SHARE_LINK_INVALID,
        message: 'This form is not available.',
      });
    }

    const saved = await this.submissions.save(
      this.submissions.create({
        trainerProfileId: link.trainerProfileId,
        // Same shape as a ShareLink code; the unique index catches collisions.
        token: randomBytes(16).toString('base64url'),
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        email: dto.email,
        phone: dto.phone ?? null,
        playerName: dto.playerName ?? null,
        birthDate: dto.birthDate ?? null,
        gender: dto.gender ?? null,
        convertedUserId: null,
        convertedAt: null,
        shareLinkSentAt: null,
      }),
    );

    await this.audit.recordSystemAction({
      action: AUDIT_CAMP_SUBMITTED,
      target: { type: 'CampSubmission', id: saved.id },
      metadata: { trainerProfileId: link.trainerProfileId },
    });
    return this.toPrefillView(saved, await this.trainerNameOf(saved.trainerProfileId));
  }

  /** What the registration form reads to pre-fill itself. Public by token. */
  async prefill(token: string): Promise<CampSubmissionPrefillView> {
    const submission = await this.requireByToken(token);
    return this.toPrefillView(submission, await this.trainerNameOf(submission.trainerProfileId));
  }

  /**
   * Finish the conversion: create the account from what the form already holds
   * and connect it to the trainer, without asking for any of it again.
   */
  async convert(token: string, dto: ConvertCampSubmissionDto): Promise<JoinResult> {
    const submission = await this.requireByToken(token);
    if (submission.convertedUserId !== null) {
      throw new ConflictException({
        errorCode: ErrorCode.SUBMISSION_ALREADY_CONVERTED,
        message: 'This form has already been used to create an account.',
      });
    }

    const birthDate = dto.birthDate ?? submission.birthDate;
    if (!birthDate) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'birthDate is required; the form did not capture one.',
      });
    }

    const link = await this.shareLinks.findActivePlayerLink(submission.trainerProfileId);
    if (!link) {
      throw new NotFoundException({
        errorCode: ErrorCode.SHARE_LINK_INVALID,
        message: 'This trainer is no longer accepting sign-ups.',
      });
    }

    // Delegates to the ShareLink path rather than restating it: the age gate,
    // the link lock, profile creation and the trainer association all live there
    // and must behave identically whichever door the account came through.
    const registration: JoinRegisterDto = {
      email: submission.email,
      password: dto.password,
      firstName: dto.firstName ?? submission.firstName,
      lastName: dto.lastName ?? submission.lastName ?? undefined,
      phone: dto.phone ?? submission.phone ?? undefined,
      gender: submission.gender ?? undefined,
      birthDate,
    };
    const result = await this.joinService.registerViaShareLink(link.code, registration);

    const account = await this.usersService.findByEmail(submission.email);
    submission.convertedUserId = account?.id ?? null;
    submission.convertedAt = this.clock.now();
    await this.submissions.save(submission);

    await this.audit.recordSystemAction({
      action: AUDIT_CAMP_CONVERTED,
      targetUserId: account?.id ?? null,
      target: { type: 'CampSubmission', id: submission.id },
      metadata: { trainerProfileId: submission.trainerProfileId },
    });
    return result;
  }

  async listForTrainer(trainerUserId: string): Promise<CampSubmissionView[]> {
    const trainer = await this.trainersService.requireOwnProfile(trainerUserId);
    const rows = await this.submissions.find({
      where: { trainerProfileId: trainer.id },
      order: { submittedAt: 'DESC' },
    });
    return rows.map((row) => ({
      ...this.toPrefillView(row, trainer.businessName),
      id: row.id,
      submittedAt: row.submittedAt,
      convertedAt: row.convertedAt,
      shareLinkSentAt: row.shareLinkSentAt,
    }));
  }

  /**
   * The alternative route: mail them the trainer's ShareLink so they can
   * register later, instead of converting on the spot.
   */
  async sendShareLink(actor: Principal, submissionId: string): Promise<CampSubmissionView> {
    const trainer = await this.trainersService.requireOwnProfile(actor.userId);
    const submission = await this.submissions.findOne({ where: { id: submissionId } });
    if (!submission || submission.trainerProfileId !== trainer.id) {
      throw new NotFoundException({
        errorCode: ErrorCode.SUBMISSION_NOT_FOUND,
        message: 'Submission not found.',
      });
    }
    if (submission.convertedUserId !== null) {
      throw new ConflictException({
        errorCode: ErrorCode.SUBMISSION_ALREADY_CONVERTED,
        message: 'This person already has an account.',
      });
    }

    const link = await this.shareLinks.findActivePlayerLink(trainer.id);
    if (!link) {
      throw new NotFoundException({
        errorCode: ErrorCode.SHARE_LINK_INVALID,
        message: 'Generate a player ShareLink before sending one.',
      });
    }

    await this.mail.sendCampShareLinkEmail(submission.email, {
      firstName: submission.firstName,
      trainerName: trainer.businessName,
      code: link.code,
    });

    submission.shareLinkSentAt = this.clock.now();
    const saved = await this.submissions.save(submission);
    await this.audit.record({
      action: AUDIT_CAMP_SHARE_LINK_SENT,
      actor,
      target: { type: 'CampSubmission', id: saved.id },
      metadata: { code: link.code },
    });

    return {
      ...this.toPrefillView(saved, trainer.businessName),
      id: saved.id,
      submittedAt: saved.submittedAt,
      convertedAt: saved.convertedAt,
      shareLinkSentAt: saved.shareLinkSentAt,
    };
  }

  /**
   * GDPR sweep. A submission holds a name, an address, a phone number and a
   * birth date for someone who may never have registered, so it is a copy of
   * the person's PII living outside `users` — the same class as a ShareLink's
   * target email. Matched on the pre-anonymisation address, and the token is
   * cleared too so the pre-fill payload cannot be fetched again.
   */
  async scrubByEmail(email: string, manager?: EntityManager): Promise<void> {
    await repoFor(this.submissions, CampSubmission, manager)
      .createQueryBuilder()
      .update(CampSubmission)
      .set({
        firstName: 'Deleted',
        lastName: null,
        email: () => `'deleted_' || "id" || '@example.com'`,
        phone: null,
        playerName: null,
        birthDate: null,
        gender: null,
        token: () => `'scrubbed_' || "id"`,
      })
      .where('LOWER("email") = LOWER(:email)', { email })
      .execute();
  }

  private async requireByToken(token: string): Promise<CampSubmission> {
    const submission = await this.submissions.findOne({ where: { token } });
    if (!submission) {
      throw new NotFoundException({
        errorCode: ErrorCode.SUBMISSION_NOT_FOUND,
        message: 'Submission not found.',
      });
    }
    return submission;
  }

  private async trainerNameOf(trainerProfileId: string): Promise<string> {
    const trainer = await this.trainersService.findById(trainerProfileId);
    return trainer?.businessName ?? '';
  }

  private toPrefillView(row: CampSubmission, trainerName: string): CampSubmissionPrefillView {
    return {
      token: row.token,
      trainerProfileId: row.trainerProfileId,
      trainerName,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      phone: row.phone,
      playerName: row.playerName,
      birthDate: row.birthDate,
      gender: row.gender,
      converted: row.convertedUserId !== null,
    };
  }
}
