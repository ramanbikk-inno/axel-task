import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';

import { ClockService } from '../../shared/clock/clock.service';
import { ErrorCode } from '../../shared/errors/error-codes';
import { AuditService } from '../audit/audit.service';
import { Principal } from '../auth/principal';
import { Event } from '../events/entities/event.entity';
import { EventsService } from '../events/events.service';
import { MailService } from '../mail/mail.service';
import { OrgMembershipService } from '../org-membership/org-membership.service';
import { PlayerProfile } from '../players/entities/player-profile.entity';
import { PlayersService } from '../players/players.service';
import { UsersService } from '../users/users.service';
import { PurchaseApprovalView, RequestPurchaseDto, RespondToApprovalDto } from './dto/approval.dto';
import { ApprovalStatus, PaymentType, PurchaseApproval } from './entities/purchase-approval.entity';

export const AUDIT_PURCHASE_REQUESTED = 'purchase.requested';
export const AUDIT_PURCHASE_APPROVED = 'purchase.approved';
export const AUDIT_PURCHASE_DENIED = 'purchase.denied';
export const AUDIT_PURCHASE_EXPIRED = 'purchase.expired';

/** "Pending requests expire after 48 hours (auto-deny with notification)". */
export const APPROVAL_TTL_MS = 48 * 60 * 60 * 1000;

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    @InjectRepository(PurchaseApproval)
    private readonly approvals: Repository<PurchaseApproval>,
    private readonly events: EventsService,
    private readonly orgMembership: OrgMembershipService,
    private readonly playersService: PlayersService,
    private readonly usersService: UsersService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly clock: ClockService,
  ) {}

  /**
   * A child asks to attend something that costs. USD always waits for a parent;
   * tokens wait too unless the parent turned that requirement off for this child.
   */
  async request(actor: Principal, dto: RequestPurchaseDto): Promise<PurchaseApprovalView> {
    const child = await this.requireChildProfile(actor);
    // The id is caller-supplied, so existence is not permission: 404 either way,
    // so a child cannot tell a foreign event from one that was never there.
    const event = await this.events.findById(dto.eventId);
    if (!event || !(await this.orgMembership.isOrgMember(actor, event.trainerProfileId))) {
      throw new NotFoundException({
        errorCode: ErrorCode.EVENT_NOT_FOUND,
        message: 'Event not found.',
      });
    }

    const amount =
      dto.paymentType === PaymentType.Usd ? (event.priceCents ?? 0) : (event.priceTokens ?? 0);
    if (amount <= 0) {
      throw new BadRequestException({
        errorCode: ErrorCode.VALIDATION_ERROR,
        message: 'This event has no price for that payment type.',
      });
    }

    // Expiry is lazy, so anything reading pending state has to settle it first —
    // otherwise a request that lapsed overnight keeps blocking the next one
    // until somebody happens to open the parent's queue.
    await this.expireOverdue(child.ownerUserId);

    const open = await this.approvals.findOne({
      where: {
        childPlayerProfileId: child.id,
        eventId: event.id,
        status: ApprovalStatus.Pending,
      },
    });
    if (open) {
      throw new ConflictException({
        errorCode: ErrorCode.APPROVAL_NOT_PENDING,
        message: 'A request for this event is already awaiting your parent.',
      });
    }

    // The one case that does not wait: tokens, with the parent's standing
    // permission on this child's profile.
    const autoApproved =
      dto.paymentType === PaymentType.Tokens && child.allowChildTokenSpendNoApproval;
    const now = this.clock.now();

    const saved = await this.approvals.save(
      this.approvals.create({
        childPlayerProfileId: child.id,
        parentUserId: child.ownerUserId,
        eventId: event.id,
        amount,
        paymentType: dto.paymentType,
        status: autoApproved ? ApprovalStatus.Approved : ApprovalStatus.Pending,
        parentNotes: null,
        respondedAt: autoApproved ? now : null,
        expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
        autoApproved,
      }),
    );

    await this.audit.record({
      action: autoApproved ? AUDIT_PURCHASE_APPROVED : AUDIT_PURCHASE_REQUESTED,
      actor,
      target: { type: 'PurchaseApproval', id: saved.id },
      metadata: {
        eventId: event.id,
        amount,
        paymentType: dto.paymentType,
        autoApproved,
      },
    });

    await this.notifyParent(saved, child, event);
    return this.toView(saved, child, event);
  }

  /**
   * The parent's queue. Expiry is settled on read rather than by a scheduler:
   * the same lazy reconciliation the impersonation logs use, so a request that
   * timed out overnight cannot be answered the next morning.
   */
  async listForParent(
    parentUserId: string,
    status?: ApprovalStatus,
  ): Promise<PurchaseApprovalView[]> {
    await this.expireOverdue(parentUserId);
    const rows = await this.approvals.find({
      where: { parentUserId, ...(status ? { status } : {}) },
      order: { requestedAt: 'DESC' },
    });
    return this.decorate(rows);
  }

  /** What the child sees: their own requests and how they were answered. */
  async listForChild(actor: Principal): Promise<PurchaseApprovalView[]> {
    const child = await this.requireChildProfile(actor);
    await this.expireOverdue(child.ownerUserId);
    const rows = await this.approvals.find({
      where: { childPlayerProfileId: child.id },
      order: { requestedAt: 'DESC' },
    });
    return this.decorate(rows);
  }

  async approve(
    actor: Principal,
    id: string,
    dto: RespondToApprovalDto,
  ): Promise<PurchaseApprovalView> {
    return this.respond(actor, id, ApprovalStatus.Approved, dto);
  }

  async deny(
    actor: Principal,
    id: string,
    dto: RespondToApprovalDto,
  ): Promise<PurchaseApprovalView> {
    return this.respond(actor, id, ApprovalStatus.Denied, dto);
  }

  private async respond(
    actor: Principal,
    id: string,
    status: ApprovalStatus.Approved | ApprovalStatus.Denied,
    dto: RespondToApprovalDto,
  ): Promise<PurchaseApprovalView> {
    if (actor.isChild) {
      throw new ForbiddenException({
        errorCode: ErrorCode.CHILD_ACTION_NOT_ALLOWED,
        message: 'Only a parent can answer a purchase request.',
      });
    }

    const approval = await this.approvals.findOne({ where: { id } });
    if (!approval || approval.parentUserId !== actor.userId) {
      throw new NotFoundException({
        errorCode: ErrorCode.APPROVAL_NOT_FOUND,
        message: 'Request not found.',
      });
    }

    const now = this.clock.now();
    // Checked before the status test so a lapsed request reports why, rather
    // than the generic "already answered".
    if (
      approval.status === ApprovalStatus.Pending &&
      approval.expiresAt.getTime() <= now.getTime()
    ) {
      await this.markExpired(approval, now);
      throw new ConflictException({
        errorCode: ErrorCode.APPROVAL_EXPIRED,
        message: 'This request expired after 48 hours and was declined automatically.',
      });
    }
    if (approval.status !== ApprovalStatus.Pending) {
      throw new ConflictException({
        errorCode: ErrorCode.APPROVAL_NOT_PENDING,
        message: 'This request has already been answered.',
      });
    }

    approval.status = status;
    approval.parentNotes = dto.notes ?? null;
    approval.respondedAt = now;
    const saved = await this.approvals.save(approval);

    await this.audit.record({
      action: status === ApprovalStatus.Approved ? AUDIT_PURCHASE_APPROVED : AUDIT_PURCHASE_DENIED,
      actor,
      target: { type: 'PurchaseApproval', id: saved.id },
      metadata: { status, hasNotes: dto.notes !== undefined },
    });

    await this.notifyChildOfDecision(saved);
    const [view] = await this.decorate([saved]);
    return view;
  }

  /**
   * Auto-deny whatever ran out of time for this parent. Runs before every read
   * and every decision, so no scheduler is required for the 48-hour rule to hold.
   */
  private async expireOverdue(parentUserId: string): Promise<void> {
    const now = this.clock.now();
    const overdue = await this.approvals.find({
      where: {
        parentUserId,
        status: ApprovalStatus.Pending,
        expiresAt: LessThanOrEqual(now),
      },
    });
    for (const row of overdue) {
      await this.markExpired(row, now);
    }
  }

  private async markExpired(approval: PurchaseApproval, now: Date): Promise<void> {
    approval.status = ApprovalStatus.Expired;
    approval.respondedAt = now;
    await this.approvals.save(approval);
    await this.audit.recordSystemAction({
      action: AUDIT_PURCHASE_EXPIRED,
      target: { type: 'PurchaseApproval', id: approval.id },
      metadata: { childPlayerProfileId: approval.childPlayerProfileId },
    });
    await this.notifyChildOfDecision(approval);
  }

  private async requireChildProfile(actor: Principal): Promise<PlayerProfile> {
    if (!actor.isChild || actor.childPlayerProfileId === null) {
      throw new ForbiddenException({
        errorCode: ErrorCode.FORBIDDEN,
        message: 'Only a child login can request a purchase.',
      });
    }
    const profile = await this.playersService.findById(actor.childPlayerProfileId);
    if (!profile) {
      throw new NotFoundException({
        errorCode: ErrorCode.PLAYER_PROFILE_NOT_FOUND,
        message: 'Player profile not found.',
      });
    }
    return profile;
  }

  /** Email delivery must never fail the request that triggered it. */
  private async notifyParent(
    approval: PurchaseApproval,
    child: PlayerProfile,
    event: Event,
  ): Promise<void> {
    try {
      const parent = await this.usersService.findById(approval.parentUserId);
      if (!parent) {
        return;
      }
      if (approval.autoApproved) {
        await this.mail.sendChildPurchaseNoticeEmail(parent.email, {
          childName: child.displayName,
          eventTitle: event.title,
          amount: approval.amount,
          paymentType: approval.paymentType,
        });
      } else {
        await this.mail.sendPurchaseApprovalRequestEmail(parent.email, {
          childName: child.displayName,
          eventTitle: event.title,
          amount: approval.amount,
          paymentType: approval.paymentType,
          expiresAt: approval.expiresAt,
        });
      }
    } catch (error) {
      this.logger.warn(`purchase notification to parent failed: ${String(error)}`);
    }
  }

  private async notifyChildOfDecision(approval: PurchaseApproval): Promise<void> {
    try {
      const child = await this.playersService.findById(approval.childPlayerProfileId);
      if (!child?.childUserId) {
        return;
      }
      const childUser = await this.usersService.findById(child.childUserId);
      const event = await this.events.findById(approval.eventId);
      if (!childUser || !event) {
        return;
      }
      await this.mail.sendPurchaseDecisionEmail(childUser.email, {
        childName: child.displayName,
        eventTitle: event.title,
        status: approval.status,
        notes: approval.parentNotes,
      });
    } catch (error) {
      this.logger.warn(`purchase decision notification failed: ${String(error)}`);
    }
  }

  /** One batched lookup of children and events for a page of rows. */
  private async decorate(rows: PurchaseApproval[]): Promise<PurchaseApprovalView[]> {
    if (rows.length === 0) {
      return [];
    }
    const children = await this.playersService.findByIds([
      ...new Set(rows.map((r) => r.childPlayerProfileId)),
    ]);
    const childById = new Map(children.map((c) => [c.id, c]));
    const events = await this.approvals.manager.find(Event, {
      where: { id: In([...new Set(rows.map((r) => r.eventId))]) },
    });
    const eventById = new Map(events.map((e) => [e.id, e]));

    return rows.map((r) =>
      this.toView(r, childById.get(r.childPlayerProfileId), eventById.get(r.eventId)),
    );
  }

  private toView(
    row: PurchaseApproval,
    child: PlayerProfile | undefined,
    event: Event | undefined,
  ): PurchaseApprovalView {
    return {
      id: row.id,
      childPlayerProfileId: row.childPlayerProfileId,
      childDisplayName: child?.displayName ?? 'Unknown',
      parentUserId: row.parentUserId,
      eventId: row.eventId,
      eventTitle: event?.title ?? '',
      eventStartsAt: event?.startsAt as Date,
      amount: row.amount,
      paymentType: row.paymentType,
      status: row.status,
      parentNotes: row.parentNotes,
      requestedAt: row.requestedAt,
      respondedAt: row.respondedAt,
      expiresAt: row.expiresAt,
      autoApproved: row.autoApproved,
    };
  }
}
