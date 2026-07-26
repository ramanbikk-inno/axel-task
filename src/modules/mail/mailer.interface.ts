export const MAILER = Symbol('MAILER');

export interface Mailer {
  sendVerification(input: { to: string; verifyUrl: string }): Promise<void>;
  sendPasswordReset(input: { to: string; resetUrl: string }): Promise<void>;
  sendPasswordChanged(input: { to: string }): Promise<void>;
  sendWelcome(input: { to: string; firstName: string }): Promise<void>;
  sendTrainerInvite(input: { to: string; firstName: string; setupUrl: string }): Promise<void>;
  sendJoinConfirmation(input: { to: string; trainerName: string }): Promise<void>;
  sendCoachInvite(input: {
    to: string;
    trainerName: string;
    acceptUrl: string;
    message?: string;
  }): Promise<void>;
  /** A child tried to join a trainer; the parent must complete it. */
  sendChildJoinRequest(input: {
    to: string;
    childName: string;
    trainerName: string;
    joinUrl: string;
  }): Promise<void>;
  sendCoachAvailabilityOverride(input: {
    to: string;
    trainerName: string;
    dayName: string;
    startTime: string;
    endTime: string;
    reason: string;
  }): Promise<void>;
}
