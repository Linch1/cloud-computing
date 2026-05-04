/**
 * Redis layout for users:
 *   user:{userId}        -> hash { id, email, passwordHash, role, createdAt }
 *   user_email:{email}   -> userId   (lowercased email, secondary index)
 */

const userKey = (id) => `user:${id}`;
const emailKey = (email) => `user_email:${email.toLowerCase()}`;

export function createUserRepository(redis) {
  return {
    async findById(id) {
      const data = await redis.hgetall(userKey(id));
      if (!data || !data.id) return null;
      return data;
    },

    async findByEmail(email) {
      const id = await redis.get(emailKey(email));
      if (!id) return null;
      return this.findById(id);
    },

    /**
     * Atomically reserves the email and writes the user. Returns false if
     * the email is already taken.
     * @param {{id:string,email:string,passwordHash:string,role:"admin"|"voter"}} user
     */
    async create(user) {
      const email = user.email.toLowerCase();
      const reserved = await redis.set(emailKey(email), user.id, "NX");
      if (reserved !== "OK") return false;

      await redis.hset(userKey(user.id), {
        id: user.id,
        email,
        passwordHash: user.passwordHash,
        role: user.role,
        createdAt: new Date().toISOString(),
      });
      return true;
    },
  };
}
