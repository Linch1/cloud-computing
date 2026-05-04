import { createElectionSchema, electionIdParam } from "../schemas/election.schemas.js";

export default async function adminRoutes(app) {
  const { electionService } = app.services;

  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.requireAdmin);

  app.post("/admin/elections", async (req, reply) => {
    const body = createElectionSchema.parse(req.body);
    const election = await electionService.create(body, {
      id: req.user.sub,
      email: req.user.email,
    });
    return reply.code(201).send({ election });
  });

  app.post("/admin/elections/:id/open", async (req) => {
    const { id } = electionIdParam.parse(req.params);
    const election = await electionService.open(id);
    return { election };
  });

  app.post("/admin/elections/:id/close", async (req) => {
    const { id } = electionIdParam.parse(req.params);
    const election = await electionService.close(id);
    return { election };
  });

  app.get("/admin/elections", async () => {
    const elections = await electionService.list();
    return { elections };
  });
}
