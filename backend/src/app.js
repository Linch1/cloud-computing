import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import { loadConfig } from "./config/index.js";
import redisPlugin from "./plugins/redis.js";
import authPlugin from "./plugins/auth.js";
import blockchainPlugin from "./plugins/blockchain.js";
import errorHandlerPlugin from "./plugins/errorHandler.js";

import { createUserRepository } from "./repositories/user.repository.js";
import { createElectionRepository } from "./repositories/election.repository.js";
import { createVoteRepository } from "./repositories/vote.repository.js";

import { createAuthService } from "./services/auth.service.js";
import { createElectionService } from "./services/election.service.js";
import { createVoteService } from "./services/vote.service.js";

import authRoutes from "./routes/auth.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import electionsRoutes from "./routes/elections.routes.js";
import votesRoutes from "./routes/votes.routes.js";

/**
 * Builds and returns a fully wired Fastify instance.
 *
 * @param {{
 *   config?: ReturnType<typeof loadConfig>,
 *   redisClient?: import("ioredis").Redis,
 *   chainClient?: object,
 * }} [opts] Test seams: inject a Redis mock and/or a fake chain client.
 */
export async function buildApp(opts = {}) {
  const config = opts.config ?? loadConfig();

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'req.body.password',
          'req.body.passwordHash',
          'res.headers["set-cookie"]',
        ],
        censor: "[REDACTED]",
      },
      transport:
        config.NODE_ENV === "development"
          ? { target: "pino/file", options: { destination: 1 } }
          : undefined,
    },
    disableRequestLogging: false,
    trustProxy: true,
  });

  

  app.decorate("config", config);

  await app.register(errorHandlerPlugin);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {origin: "*"});
  
  app.addHook('onRequest', async (req, reply) => {
    console.log(req.method, req.url)
  })

  await app.register(redisPlugin, { client: opts.redisClient });

  await app.register(rateLimit, {
    global: false,
    redis: app.redis,
    nameSpace: "rl:",
  });

  await app.register(authPlugin);
  await app.register(blockchainPlugin, { client: opts.chainClient });

  const userRepo = createUserRepository(app.redis);
  const electionRepo = createElectionRepository(app.redis);
  const voteRepo = createVoteRepository(app.redis);

  const authService = createAuthService({ users: userRepo });
  const electionService = createElectionService({
    elections: electionRepo,
    chain: app.chain,
  });
  const voteService = createVoteService({
    elections: electionRepo,
    votes: voteRepo,
    chain: app.chain,
    salt: config.VOTER_HASH_SALT,
  });

  app.decorate("services", { authService, electionService, voteService });
  app.decorate("repositories", {
    users: userRepo,
    elections: electionRepo,
    votes: voteRepo,
  });

  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

  app.get("/build", async () => ({
    status: "ok",
    gitSha: process.env.GIT_SHA ?? "unknown",
    buildTime: process.env.BUILD_TIME ?? "unknown",
    node: process.version,
  }));

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(electionsRoutes);
  await app.register(votesRoutes);

  return app;
}
