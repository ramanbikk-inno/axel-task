import { Entity } from 'typeorm';

import { SingleUseTokenBase } from './single-use-token.base';

@Entity({ name: 'account_setup_tokens' })
export class AccountSetupToken extends SingleUseTokenBase {}
