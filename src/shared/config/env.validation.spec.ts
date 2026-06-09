import { validate } from './env.validation';

describe('validate (env)', () => {
  const validEnv: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '3000',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_USER: 'axel',
    DB_PASSWORD: 'axel',
    DB_NAME: 'axel',
    JWT_ACCESS_SECRET: 'access-secret-value-at-least-32-chars-long',
    JWT_REFRESH_SECRET: 'refresh-secret-value-at-least-32-chars',
    SUPER_ADMIN_EMAIL: 'admin@example.com',
    SUPER_ADMIN_PASSWORD: 'Str0ng!Passw0rd',
    RESEND_API_KEY: 're_testkey',
    MAIL_FROM: 'no-reply@example.com',
    CLOUDINARY_URL: 'cloudinary://key:secret@cloud',
    CORS_ORIGINS: 'http://localhost:3000',
    APP_URL: 'http://localhost:3000',
  };

  it('throws when JWT_ACCESS_SECRET is missing', () => {
    const { JWT_ACCESS_SECRET, ...withoutAccessSecret } = validEnv;
    expect(() => validate(withoutAccessSecret)).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('passes on a valid fixture and applies ARGON defaults', () => {
    const result = validate(validEnv);
    expect(result.JWT_ACCESS_SECRET).toBe(validEnv.JWT_ACCESS_SECRET);
    expect(result.ARGON_MEMORY_KIB).toBe(19456);
    expect(result.ARGON_TIME_COST).toBe(2);
    expect(result.ARGON_PARALLELISM).toBe(1);
    expect(result.APP_URL).toBe('http://localhost:3000');
  });

  it('coerces numeric env strings into numbers', () => {
    const result = validate(validEnv);
    expect(result.PORT).toBe(3000);
    expect(result.DB_PORT).toBe(5432);
    expect(typeof result.PORT).toBe('number');
  });
});
