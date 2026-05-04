import { electionIdParam } from "../schemas/election.schemas.js";
import { castVoteSchema } from "../schemas/vote.schemas.js";
import { forbidden } from "../utils/errors.js";

export default async function votesRoutes(app) {
  const { voteService } = app.services;

  app.addHook("preHandler", app.authenticate);

  app.post(
    "/elections/:id/vote",
    {
      config: {
        rateLimit: {
          max: app.config.RATE_LIMIT_VOTE_MAX,
          timeWindow: app.config.RATE_LIMIT_VOTE_WINDOW,
          keyGenerator: (req) => `vote:${req.user?.sub ?? req.ip}`,
        },
      },
    },
    async (req, reply) => {
      if (req.user.role !== "voter" && req.user.role !== "admin") {
        throw forbidden("FORBIDDEN", "Only voters can cast votes");
      }
      const { id } = electionIdParam.parse(req.params);
      const body = castVoteSchema.parse(req.body);
      const result = await voteService.castVote(
        { id: req.user.sub },
        id,
        body
      );
      return reply.code(201).send({ vote: result });
    }
  );

  app.get("/elections/:id/my-vote-status", async (req) => {
    const { id } = electionIdParam.parse(req.params);
    const status = await voteService.getMyStatus({ id: req.user.sub }, id);
    return { status };
  });
}
