export const MAILER = Symbol('MAILER');

export interface Mailer {
  sendVerification(input: { to: string; verifyUrl: string }): Promise<void>;
  sendPasswordReset(input: { to: string; resetUrl: string }): Promise<void>;
  sendPasswordChanged(input: { to: string }): Promise<void>;
  sendWelcome(input: { to: string; firstName: string }): Promise<void>;
  sendTrainerInvite(input: { to: string; firstName: string; setupUrl: string }): Promise<void>;
}
