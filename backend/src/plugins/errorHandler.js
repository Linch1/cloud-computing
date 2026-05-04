import fp from "fastify-plugin";
import { ZodError } from "zod";
import { HttpError } from "../utils/errors.js";

/**
 * Centralized error handler. Maps known error types (Zod validation,
 * HttpError, JWT errors) to clean JSON responses, logs unexpected ones
 * and never leaks internals to the client in production.
 */
export default fp(async function errorHandlerPlugin(app) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: "Invalid request payload",
        issues: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
          code: i.code,
        })),
      });
    }

    if (err instanceof HttpError) {
      const body = { error: err.code, message: err.message };
      if (err.details) body.details = err.details;
      return reply.code(err.statusCode).send(body);
    }

    if (err.statusCode === 429) {
      return reply.code(429).send({
        error: "RATE_LIMITED",
        message: err.message || "Too many requests",
      });
    }

    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({
        error: err.code || "BAD_REQUEST",
        message: err.message,
      });
    }

    req.log.error({ err }, "Unhandled error");
    return reply.code(500).send({
      error: "INTERNAL_ERROR",
      message:
        app.config.NODE_ENV === "production"
          ? "Internal server error"
          : err.message,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: "NOT_FOUND",
      message: `Route ${req.method} ${req.url} not found`,
    });
  });
});
