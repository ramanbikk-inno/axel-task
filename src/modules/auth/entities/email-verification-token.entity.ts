import { Entity } from 'typeorm';

import { SingleUseTokenBase } from './single-use-token.base';

@Entity({ name: 'email_verification_tokens' })
export class EmailVerificationToken extends SingleUseTokenBase {}
