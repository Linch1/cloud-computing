/**
 * Redis layout for votes:
 *   vote:{electionId}:{userId}        -> JSON { voteHash, voterCommitmentHash,
 *                                               selectedOption, nonce, txHash,
 *                                               blockNumber, castAt }
 *   lock:vote:{electionId}:{userId}   -> short-lived advisory lock used to
 *                                        prevent two concurrent castVote calls
 *                                        for the same (election, user).
 */

const voteKey = (electionId, userId) => `vote:${electionId}:${userId}`;
const lockKey = (electionId, userId) => `lock:vote:${electionId}:${userId}`;

export function createVoteRepository(redis) {
  return {
    async findByUser(electionId, userId) {
      const raw = await redis.get(voteKey(electionId, userId));
      if (!raw) return null;
      return JSON.parse(raw);
    },

    async save(electionId, userId, vote) {
      await redis.set(voteKey(electionId, userId), JSON.stringify(vote));
    },

    /**
     * Acquire an advisory lock. Returns true if acquired, false otherwise.
     * @param {string|number} electionId
     * @param {string} userId
     * @param {number} ttlSeconds
     */
    async acquireLock(electionId, userId, ttlSeconds = 30) {
      const res = await redis.set(
        lockKey(electionId, userId),
        "1",
        "EX",
        ttlSeconds,
        "NX"
      );
      return res === "OK";
    },

    async releaseLock(electionId, userId) {
      await redis.del(lockKey(electionId, userId));
    },
  };
}
