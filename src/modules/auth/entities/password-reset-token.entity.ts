import { Entity } from 'typeorm';

import { SingleUseTokenBase } from './single-use-token.base';

@Entity({ name: 'password_reset_tokens' })
export class PasswordResetToken extends SingleUseTokenBase {}
