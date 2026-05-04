import { electionIdParam } from "../schemas/election.schemas.js";

export default async function electionsRoutes(app) {
  const { electionService } = app.services;

  app.get("/elections", async () => {
    const elections = await electionService.list();
    return { elections };
  });

  app.get("/elections/:id", async (req) => {
    const { id } = electionIdParam.parse(req.params);
    const election = await electionService.getById(id);
    return { election };
  });

  app.get("/elections/:id/status", async (req) => {
    const { id } = electionIdParam.parse(req.params);
    const status = await electionService.getStatus(id);
    return { status };
  });
}
