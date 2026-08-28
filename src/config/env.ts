import 'dotenv/config';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform(value => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CONTROL_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MONGODB_URI: z.string().min(1),
  BOT_DB_NAME: z.string().min(1).default('eventflow_supplier_bot'),
  REDIS_URL: z.string().url(),
  BOT_QUEUE_NAMESPACE: z.string().min(1).default('eventflow-supplier-bot'),
  CONTROL_ADMIN_KEY: z.string().min(24),
  CONTROL_SESSION_SECRET: z.string().min(32),
  ABSOLUTE_MAX_PROFILES_PER_DAY: z.coerce.number().int().positive().default(1000),
  ABSOLUTE_MAX_CRAWLS_PER_DAY: z.coerce.number().int().positive().default(5000),
  ABSOLUTE_MAX_BROWSER_CRAWLS_PER_DAY: z.coerce.number().int().nonnegative().default(100),
  ABSOLUTE_MAX_PROVIDER_SEARCHES_PER_DAY: z.coerce.number().int().positive().default(500),
  ABSOLUTE_MAX_AI_SPEND_GBP_PER_DAY: z.coerce.number().positive().default(50),
  BROWSER_CRAWL_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(30000),
  BROWSER_RENDER_SETTLE_MS: z.coerce.number().int().min(250).max(10000).default(1500),
  BROWSER_MAX_PAGES: z.coerce.number().int().min(1).max(8).default(4),
  BROWSER_MAX_HTML_BYTES: z.coerce.number().int().min(100000).max(5000000).default(2000000),
  BROWSER_ALLOW_NO_SANDBOX: booleanString,
  BRAVE_API_KEY: z.string().optional(),
  BRAVE_PERSISTENCE_ALLOWED: booleanString,
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EXTRACTION_MODEL: z.string().min(1).default('gpt-5.6-luna'),
  OPENAI_ESCALATION_MODEL: z.string().min(1).default('gpt-5.6-terra'),
  OPENAI_MAX_EVIDENCE_FRAGMENTS: z.coerce.number().int().min(1).max(20).default(8),
  OPENAI_MAX_EVIDENCE_CHARS: z.coerce.number().int().min(1000).max(50000).default(14000),
  OPENAI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(45000),
  OPENAI_BUDGET_RESERVATION_GBP_PER_CALL: z.coerce.number().positive().max(10).default(0.10),
  OPENAI_ESTIMATED_GBP_PER_MILLION_TOKENS: z.coerce.number().positive().max(100).default(8),
  OPENAI_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(2).max(50).default(5),
  OPENAI_CIRCUIT_OPEN_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  EVENTFLOW_INTERNAL_BASE_URL: z.string().url().optional(),
  EVENTFLOW_BOT_HMAC_SECRET: z.string().min(32).optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map(issue => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid Supplier Bot environment: ${issues}`);
}

export const env = Object.freeze({
  ...parsed.data,
  CONTROL_PORT: parsed.data.PORT ?? parsed.data.CONTROL_PORT,
});

export type Env = typeof env;
