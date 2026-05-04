import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildTestApp } from "./helpers/buildTestApp.js";

async function createOpenElection(ctx) {
  const { token } = await ctx.loginAdmin();
  const now = Math.floor(Date.now() / 1000);
  const startTime = now + 120;
  const endTime = now + 3600;
  await ctx.app.inject({
    method: "POST",
    url: "/admin/elections",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      title: "Vote test",
      description: "",
      options: ["Alice", "Bob", "Carol"],
      startTime,
      endTime,
    },
  });
  const opened = await ctx.app.inject({
    method: "POST",
    url: "/admin/elections/0/open",
    headers: { authorization: `Bearer ${token}` },
  });
  if (opened.statusCode !== 200) throw new Error("Failed to open: " + opened.body);
  return token;
}

describe("voting", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildTestApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it("voter can cast a vote on an active election", async () => {
    await createOpenElection(ctx);
    const { token } = await ctx.registerVoter("v1@test.local");

    const res = await ctx.app.inject({
      method: "POST",
      url: "/elections/0/vote",
      headers: { authorization: `Bearer ${token}` },
      payload: { selectedOption: 1 },
    });
    expect(res.statusCode).toBe(201);
    const { vote } = res.json();
    expect(vote.txHash).toMatch(/^0x[0-9a-f]+$/);
    expect(vote.voteHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(vote.voterCommitmentHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("prevents double vote (off-chain check)", async () => {
    await createOpenElection(ctx);
    const { token } = await ctx.registerVoter("v2@test.local");

    const r1 = await ctx.app.inject({
      method: "POST",
      url: "/elections/0/vote",
      headers: { authorization: `Bearer ${token}` },
      payload: { selectedOption: 0 },
    });
    expect(r1.statusCode).toBe(201);

    const r2 = await ctx.app.inject({
      method: "POST",
      url: "/elections/0/vote",
      headers: { authorization: `Bearer ${token}` },
      payload: { selectedOption: 2 },
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe("ALREADY_VOTED");
  });

  it("prevents double vote even if Redis state is wiped (on-chain check)", async () => {
    await createOpenElection(ctx);
    const { token, user } = await ctx.registerVoter("v3@test.local");

    const r1 = await ctx.app.inject({
      method: "POST",
      url: "/elections/0/vote",
      headers: { authorization: `Bearer ${token}` },
      payload: { selectedOption: 0 },
    });
    expect(r1.statusCode).toBe(201);

    await ctx.redis.del(`vote:0:${user.id}`);

    const r2 = await ctx.app.inject({
      method: "POST",
      url: "/elections/0/vote",
      headers: { authorization: `Bearer ${token}` },
      payload: { selectedOption: 1 },
    });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toBe("ALREADY_VOTED");
  });

  it("rejects invalid option index (semantic, beyond election options)", async () => {
    await createOpenElection(ctx);
    const { token } = await ctx.registerVoter("v4@test.local");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/elections/0/vote",
      headers: { authorization: `Bearer ${token}` },
      payload: { selectedOption: 7 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_OPTION");
  });

  it("rejects invalid option index (zod schema, out of bounds)", async () => {
    await createOpenElection(ctx);
    const { token } = await ctx.registerVoter("v4b@test.local");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/elections/0/vote",
      headers: { authorization: `Bearer ${token}` },
      payload: { selectedOption: 99 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION_ERROR");
  });

  it("rejects voting on a closed election", async () => {
    const adminToken = await createOpenElection(ctx);
    await ctx.app.inject({
      method: "POST",
      url: "/admin/elections/0/close",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const { token } = await ctx.registerVoter("v5@test.local");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/elections/0/vote",
      headers: { authorization: `Bearer ${token}` },
      payload: { selectedOption: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("ELECTION_NOT_ACTIVE");
  });

  it("vote requires authentication", async () => {
    await createOpenElection(ctx);
    const res = await ctx.app.inject({
      method: "POST",
      url: "/elections/0/vote",
      payload: { selectedOption: 0 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("my-vote-status reports correct state before/after voting", async () => {
    await createOpenElection(ctx);
    const { token } = await ctx.registerVoter("v6@test.local");

    const before = await ctx.app.inject({
      method: "GET",
      url: "/elections/0/my-vote-status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().status.hasVoted).toBe(false);

    await ctx.app.inject({
      method: "POST",
      url: "/elections/0/vote",
      headers: { authorization: `Bearer ${token}` },
      payload: { selectedOption: 0 },
    });

    const after = await ctx.app.inject({
      method: "GET",
      url: "/elections/0/my-vote-status",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().status.hasVoted).toBe(true);
    expect(after.json().status.txHash).toMatch(/^0x[0-9a-f]+$/);
  });
});
