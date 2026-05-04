import bcrypt from "bcryptjs";
import { conflict, unauthorized } from "../utils/errors.js";
import { newUserId } from "../utils/ids.js";

const BCRYPT_ROUNDS = 10;

export function createAuthService({ users }) {
  return {
    /**
     * @param {{email:string, password:string, role?:"voter"|"admin"}} input
     */
    async register(input) {
      const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
      const user = {
        id: newUserId(),
        email: input.email.toLowerCase(),
        passwordHash,
        role: input.role ?? "voter",
      };
      const ok = await users.create(user);
      if (!ok) throw conflict("EMAIL_TAKEN", "Email already registered");
      return publicUser(user);
    },

    async login({ email, password }) {
      const user = await users.findByEmail(email);
      if (!user) throw unauthorized("INVALID_CREDENTIALS", "Invalid email or password");
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) throw unauthorized("INVALID_CREDENTIALS", "Invalid email or password");
      return publicUser(user);
    },

    async getById(id) {
      const user = await users.findById(id);
      if (!user) return null;
      return publicUser(user);
    },

    /**
     * Idempotent: creates the admin only if the email is not already taken.
     * Used at boot to guarantee at least one admin exists.
     */
    async ensureAdmin({ email, password }) {
      const existing = await users.findByEmail(email);
      if (existing) return publicUser(existing);
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = {
        id: newUserId(),
        email: email.toLowerCase(),
        passwordHash,
        role: "admin",
      };
      await users.create(user);
      return publicUser(user);
    },
  };
}

function publicUser(u) {
  return { id: u.id, email: u.email, role: u.role, createdAt: u.createdAt };
}
