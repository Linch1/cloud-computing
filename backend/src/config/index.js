import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
  JWT_EXPIRES_IN: z.string().default("2h"),

  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(8),

  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  PRIVATE_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, "PRIVATE_KEY must be a 0x-prefixed 32-byte hex string"),
  CONTRACT_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "CONTRACT_ADDRESS must be a 0x-prefixed 20-byte hex string"),

  VOTER_HASH_SALT: z.string().min(16, "VOTER_HASH_SALT must be at least 16 chars"),

  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_LOGIN_WINDOW: z.string().default("1 minute"),
  RATE_LIMIT_VOTE_MAX: z.coerce.number().int().positive().default(3),
  RATE_LIMIT_VOTE_WINDOW: z.string().default("1 minute"),
});

/**
 * Loads and validates the environment.
 * @returns {z.infer<typeof envSchema>}
 */
export function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  return {
    ...cfg,
    corsOrigins: cfg.CORS_ORIGIN.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
