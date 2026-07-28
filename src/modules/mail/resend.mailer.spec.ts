import { ConfigService } from '@nestjs/config';
import { ResendMailer } from './resend.mailer';

const sendMock = jest.fn().mockResolvedValue({ data: { id: 'msg-1' }, error: null });

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  })),
}));

describe('ResendMailer (unit) — HTML escaping', () => {
  let mailer: ResendMailer;

  beforeEach(() => {
    sendMock.mockClear();
    const config = {
      get: (key: string): string | undefined => {
        if (key === 'RESEND_API_KEY') return 'test-key';
        if (key === 'MAIL_FROM') return 'no-reply@axel.test';
        return undefined;
      },
    } as unknown as ConfigService;
    mailer = new ResendMailer(config);
  });

  function sentHtml(): string {
    return sendMock.mock.calls[0][0].html as string;
  }

  it('escapes a markup payload in a coach invite message', async () => {
    await mailer.sendCoachInvite({
      to: 'coach@axel.test',
      trainerName: 'Hoops Academy',
      acceptUrl: 'https://app.axel.test/accept?code=abc',
      message: '<a href="https://evil.test">Click here</a>',
    });

    const html = sentHtml();
    expect(html).not.toContain('<a href="https://evil.test">');
    expect(html).toContain('&lt;a href=&quot;https://evil.test&quot;&gt;Click here&lt;/a&gt;');
  });

  it('escapes a markup payload in a coach availability override reason', async () => {
    await mailer.sendCoachAvailabilityOverride({
      to: 'coach@axel.test',
      trainerName: 'Hoops Academy',
      dayName: 'Monday',
      startTime: '16:00',
      endTime: '18:00',
      reason: '<script>alert(1)</script>',
    });

    const html = sentHtml();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes a markup payload in a child join-request notification', async () => {
    await mailer.sendChildJoinRequest({
      to: 'parent@axel.test',
      childName: '<img src=x onerror=alert(1)>',
      trainerName: 'Hoops Academy',
      joinUrl: 'https://app.axel.test/join/abc',
    });

    const html = sentHtml();
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes ampersands in trainer and first names without touching system-generated URLs', async () => {
    await mailer.sendTrainerInvite({
      to: 'trainer@axel.test',
      firstName: 'A&B',
      setupUrl: 'https://app.axel.test/setup?token=abc&x=1',
    });

    const html = sentHtml();
    expect(html).toContain('Hi A&amp;B,');
    expect(html).toContain('href="https://app.axel.test/setup?token=abc&x=1"');
  });
});
