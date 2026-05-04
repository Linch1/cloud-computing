import fp from "fastify-plugin";
import IORedis from "ioredis";

/**
 * Decorates the Fastify instance with a shared Redis client (`app.redis`).
 *
 * Tests can inject their own client via `opts.client` (typically an
 * `ioredis-mock` instance) so we don't need a real Redis to run them.
 */
export default fp(async function redisPlugin(app, opts) {
  const client = opts.client ?? new IORedis(app.config.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  client.on("error", (err) => {
    app.log.error({ err }, "Redis error");
  });

  app.decorate("redis", client);
  app.addHook("onClose", async () => {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  });
});
