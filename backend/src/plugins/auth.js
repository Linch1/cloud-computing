import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import { unauthorized, forbidden } from "../utils/errors.js";

/**
 * Registers JWT and exposes two decorators on the Fastify instance:
 *
 *   app.authenticate   -> preHandler that requires a valid bearer token
 *                         and attaches the user payload to `req.user`.
 *   app.requireAdmin   -> preHandler that requires `req.user.role === "admin"`.
 *                         Must be used AFTER `app.authenticate`.
 */
export default fp(async function authPlugin(app) {
  await app.register(fastifyJwt, {
    secret: app.config.JWT_SECRET,
    sign: { expiresIn: app.config.JWT_EXPIRES_IN },
  });

  app.decorate("authenticate", async (req) => {
    try {
      await req.jwtVerify();
    } catch {
      throw unauthorized("UNAUTHORIZED", "Missing or invalid access token");
    }
  });

  app.decorate("requireAdmin", async (req) => {
    if (!req.user) {
      throw unauthorized("UNAUTHORIZED", "Authentication required");
    }
    if (req.user.role !== "admin") {
      throw forbidden("FORBIDDEN", "Admin role required");
    }
  });
});
