import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { Roles } from '../ability/roles.decorator';
import { RolesGuard } from '../ability/roles.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotAChildGuard } from '../auth/guards/not-a-child.guard';
import { Principal } from '../auth/principal';
import { Role } from '../users/entities/user.enums';
import { ApprovalsService } from './approvals.service';
import { PurchaseApprovalView, RequestPurchaseDto, RespondToApprovalDto } from './dto/approval.dto';
import { ApprovalStatus } from './entities/purchase-approval.entity';

@ApiTags('purchase-approvals')
@Controller('purchase-approvals')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.PlayerParent)
@ApiBearerAuth()
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  /**
   * The child asks. USD always waits for the parent; tokens go straight through
   * only where the parent turned that requirement off for this child.
   */
  @Post()
  @HttpCode(201)
  @ApiOkResponse({ type: PurchaseApprovalView })
  async request(
    @Body() dto: RequestPurchaseDto,
    @Req() req: Request,
  ): Promise<PurchaseApprovalView> {
    return this.approvals.request(req.user as Principal, dto);
  }

  /** The child's own history; a parent gets the family queue from GET / below. */
  @Get('mine')
  @HttpCode(200)
  @ApiOkResponse({ type: [PurchaseApprovalView] })
  async mine(@Req() req: Request): Promise<PurchaseApprovalView[]> {
    return this.approvals.listForChild(req.user as Principal);
  }

  @Get()
  @HttpCode(200)
  @UseGuards(NotAChildGuard)
  @ApiQuery({ name: 'status', enum: ApprovalStatus, required: false })
  @ApiOkResponse({ type: [PurchaseApprovalView] })
  async list(
    @Req() req: Request,
    @Query('status') status?: ApprovalStatus,
  ): Promise<PurchaseApprovalView[]> {
    return this.approvals.listForParent((req.user as Principal).userId, status);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @UseGuards(NotAChildGuard)
  @ApiOkResponse({ type: PurchaseApprovalView })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondToApprovalDto,
    @Req() req: Request,
  ): Promise<PurchaseApprovalView> {
    return this.approvals.approve(req.user as Principal, id, dto);
  }

  @Post(':id/deny')
  @HttpCode(200)
  @UseGuards(NotAChildGuard)
  @ApiOkResponse({ type: PurchaseApprovalView })
  async deny(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondToApprovalDto,
    @Req() req: Request,
  ): Promise<PurchaseApprovalView> {
    return this.approvals.deny(req.user as Principal, id, dto);
  }
}
