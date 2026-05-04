import { buildApp } from "./app.js";

async function start() {
  const app = await buildApp();

  try {
    await app.services.authService.ensureAdmin({
      email: app.config.ADMIN_EMAIL,
      password: app.config.ADMIN_PASSWORD,
    });
    app.log.info({ email: app.config.ADMIN_EMAIL }, "Admin user is ready");
  } catch (err) {
    app.log.error({ err }, "Failed to seed admin user");
  }

  const shutdown = async (signal) => {
    app.log.info({ signal }, "Shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await app.listen({ port: app.config.PORT, host: app.config.HOST });
  } catch (err) {
    app.log.error({ err }, "Failed to start server");
    process.exit(1);
  }
}

start();
