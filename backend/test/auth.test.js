import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { buildTestApp } from "./helpers/buildTestApp.js";

describe("auth", () => {
  let ctx;
  beforeEach(async () => {
    ctx = await buildTestApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it("registers a new voter", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "alice@test.local", password: "Strong!Pass123" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe("alice@test.local");
    expect(body.user.role).toBe("voter");
    expect(body.user).not.toHaveProperty("passwordHash");
  });

  it("rejects duplicate email", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "bob@test.local", password: "Strong!Pass123" },
    });
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "bob@test.local", password: "Other!Pass123" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("EMAIL_TAKEN");
  });

  it("rejects invalid registration payload (zod)", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "not-an-email", password: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION_ERROR");
  });

  it("logs in with valid credentials and returns a JWT", async () => {
    await ctx.registerVoter("carol@test.local");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "carol@test.local", password: "VoterPass!123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toMatch(/^eyJ/);
  });

  it("rejects login with wrong password", async () => {
    await ctx.registerVoter("dan@test.local");
    const res = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "dan@test.local", password: "WrongPass!000" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("INVALID_CREDENTIALS");
  });

  it("/auth/me requires a valid token", async () => {
    const noToken = await ctx.app.inject({ method: "GET", url: "/auth/me" });
    expect(noToken.statusCode).toBe(401);

    const { token, user } = await ctx.registerVoter("eve@test.local");
    const ok = await ctx.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.id).toBe(user.id);
    expect(ok.json().user.email).toBe("eve@test.local");
  });

  it("seeds an admin at boot", async () => {
    const res = await ctx.loginAdmin();
    expect(res.user.role).toBe("admin");
  });
});
