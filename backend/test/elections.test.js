import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildTestApp } from "./helpers/buildTestApp.js";

const futureWindow = (offsetSec = 60, durationSec = 3600) => {
  const now = Math.floor(Date.now() / 1000);
  return { startTime: now + offsetSec, endTime: now + offsetSec + durationSec };
};

describe("elections (admin + public)", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildTestApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it("admin creates an election", async () => {
    const { token } = await ctx.loginAdmin();
    const { startTime, endTime } = futureWindow();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/elections",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Best pizza topping",
        description: "Choose wisely",
        options: ["Margherita", "Diavola", "Quattro Formaggi"],
        startTime,
        endTime,
      },
    });
    expect(res.statusCode).toBe(201);
    const { election } = res.json();
    expect(election.id).toBe("0");
    expect(election.metadataHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(election.txHash).toMatch(/^0x[0-9a-f]+$/);
    expect(election.options).toHaveLength(3);
  });

  it("blocks election creation for non-admin", async () => {
    const { token } = await ctx.registerVoter("voter1@test.local");
    const { startTime, endTime } = futureWindow();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/elections",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Try",
        description: "",
        options: ["A", "B"],
        startTime,
        endTime,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("requires authentication for /admin/elections", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/admin/elections" });
    expect(res.statusCode).toBe(401);
  });

  it("validates input (options too few, end <= start)", async () => {
    const { token } = await ctx.loginAdmin();
    const now = Math.floor(Date.now() / 1000);
    const r1 = await ctx.app.inject({
      method: "POST",
      url: "/admin/elections",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Too few options",
        description: "",
        options: ["only-one"],
        startTime: now + 60,
        endTime: now + 120,
      },
    });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toBe("VALIDATION_ERROR");

    const r2 = await ctx.app.inject({
      method: "POST",
      url: "/admin/elections",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Bad time window",
        description: "",
        options: ["A", "B"],
        startTime: now + 200,
        endTime: now + 100,
      },
    });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().error).toBe("VALIDATION_ERROR");
  });

  it("public can list and read an election, status returned from chain", async () => {
    const { token } = await ctx.loginAdmin();
    const { startTime, endTime } = futureWindow();
    await ctx.app.inject({
      method: "POST",
      url: "/admin/elections",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Pub",
        description: "",
        options: ["A", "B"],
        startTime,
        endTime,
      },
    });

    const list = await ctx.app.inject({ method: "GET", url: "/elections" });
    expect(list.statusCode).toBe(200);
    expect(list.json().elections).toHaveLength(1);

    const one = await ctx.app.inject({ method: "GET", url: "/elections/0" });
    expect(one.statusCode).toBe(200);
    expect(one.json().election.title).toBe("Pub");

    const status = await ctx.app.inject({ method: "GET", url: "/elections/0/status" });
    expect(status.statusCode).toBe(200);
    expect(["created", "active", "closed"]).toContain(status.json().status.status);
    expect(status.json().status.metadataMatches).toBe(true);
  });

  it("admin can open and close an election", async () => {
    const { token } = await ctx.loginAdmin();
    const { startTime, endTime } = futureWindow(120, 3600);
    await ctx.app.inject({
      method: "POST",
      url: "/admin/elections",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Open/Close test",
        description: "",
        options: ["A", "B"],
        startTime,
        endTime,
      },
    });

    const opened = await ctx.app.inject({
      method: "POST",
      url: "/admin/elections/0/open",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(opened.statusCode).toBe(200);

    const status = await ctx.app.inject({ method: "GET", url: "/elections/0/status" });
    expect(status.json().status.status).toBe("active");

    const closed = await ctx.app.inject({
      method: "POST",
      url: "/admin/elections/0/close",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(closed.statusCode).toBe(200);

    const status2 = await ctx.app.inject({ method: "GET", url: "/elections/0/status" });
    expect(status2.json().status.status).toBe("closed");
  });

  it("404 for unknown election", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/elections/999" });
    expect(res.statusCode).toBe(404);
  });
});
