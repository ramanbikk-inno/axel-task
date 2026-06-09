import { z } from 'zod';
import { envSchema } from './env.validation';

export type EnvConfig = z.infer<typeof envSchema>;

export type ConfigKey = keyof EnvConfig;
