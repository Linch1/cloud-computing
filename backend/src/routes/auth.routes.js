import { registerSchema, loginSchema } from "../schemas/auth.schemas.js";
import { unauthorized } from "../utils/errors.js";

export default async function authRoutes(app) {
  const { authService } = app.services;

  app.post("/auth/register", async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const user = await authService.register(body);
    return reply.code(201).send({ user });
  });

  app.post(
    "/auth/login",
    {
      config: {
        rateLimit: {
          max: app.config.RATE_LIMIT_LOGIN_MAX,
          timeWindow: app.config.RATE_LIMIT_LOGIN_WINDOW,
          keyGenerator: (req) => {
            const email = (req.body && req.body.email) || "";
            return `login:${req.ip}:${String(email).toLowerCase()}`;
          },
        },
      },
    },
    async (req) => {
      const body = loginSchema.parse(req.body);
      const user = await authService.login(body);
      const token = signAccessToken(app, user);
      return { token, user };
    }
  );

  app.get(
    "/auth/me",
    { preHandler: [app.authenticate] },
    async (req) => {
      const user = await authService.getById(req.user.sub);
      if (!user) throw unauthorized("UNAUTHORIZED", "User no longer exists");
      return { user };
    }
  );
}

function signAccessToken(app, user) {
  return app.jwt.sign({
    sub: user.id,
    email: user.email,
    role: user.role,
  });
}
