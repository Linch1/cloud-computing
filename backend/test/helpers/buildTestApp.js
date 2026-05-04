import RedisMock from "ioredis-mock";
import { buildApp } from "../../src/app.js";
import { createMockChain } from "./mockChain.js";

/**
 * Builds a Fastify app suitable for tests:
 *   - a fresh `ioredis-mock` instance (in-memory, FLUSHALL'd up-front),
 *   - a fresh in-memory chain client mirroring VotingRegistry behavior,
 *   - a static, predictable config (no real .env required).
 *
 * Returned helpers:
 *   `app`         - the Fastify instance (use `app.inject(...)`).
 *   `redis`       - the underlying ioredis-mock (for assertions / cleanup).
 *   `chain`       - the in-memory chain (state visible via `chain._state`).
 *   `registerVoter(email, password)`  - utility, creates a voter and returns {token,user}.
 *   `loginAdmin()`                    - utility, returns admin {token,user}.
 */
export async function buildTestApp(overrides = {}) {
  const redis = new RedisMock();
  await redis.flushall();
  const chain = createMockChain();

  const config = {
    PORT: 0,
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    CORS_ORIGIN: "*",
    REDIS_URL: "redis://127.0.0.1:6379",
    JWT_SECRET: "test-secret-test-secret-test-secret",
    JWT_EXPIRES_IN: "1h",
    ADMIN_EMAIL: "admin@test.local",
    ADMIN_PASSWORD: "AdminPass!123",
    RPC_URL: "http://127.0.0.1:8545",
    CHAIN_ID: 31337,
    PRIVATE_KEY:
      "0x" + "11".repeat(32),
    CONTRACT_ADDRESS: "0x" + "22".repeat(20),
    VOTER_HASH_SALT: "test-salt-test-salt-test-salt-12",
    RATE_LIMIT_LOGIN_MAX: 1000,
    RATE_LIMIT_LOGIN_WINDOW: "1 minute",
    RATE_LIMIT_VOTE_MAX: 1000,
    RATE_LIMIT_VOTE_WINDOW: "1 minute",
    corsOrigins: ["*"],
    ...overrides.config,
  };

  const app = await buildApp({
    config,
    redisClient: redis,
    chainClient: chain,
  });

  await app.services.authService.ensureAdmin({
    email: config.ADMIN_EMAIL,
    password: config.ADMIN_PASSWORD,
  });

  await app.ready();

  async function loginAdmin() {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD },
    });
    if (res.statusCode !== 200) throw new Error("Admin login failed: " + res.body);
    return res.json();
  }

  async function registerVoter(email, password = "VoterPass!123") {
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email, password },
    });
    if (reg.statusCode !== 201) throw new Error("Register failed: " + reg.body);
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password },
    });
    if (login.statusCode !== 200) throw new Error("Voter login failed: " + login.body);
    return login.json();
  }

  return { app, redis, chain, config, loginAdmin, registerVoter };
}
