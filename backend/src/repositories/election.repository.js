/**
 * Redis layout for elections:
 *   election:{electionId}   -> JSON document with full off-chain metadata
 *                              { id, title, description, options, startTime,
 *                                endTime, metadataHash, createdBy, createdAt,
 *                                txHash, blockNumber, manuallyClosed }
 *   election:list           -> SET of electionIds (used for listings)
 *
 * `electionId` here is the on-chain id assigned by the contract, so it is
 * stringified `uint256` (e.g. "0", "1", ...).
 */

const electionKey = (id) => `election:${id}`;
const ELECTION_LIST = "election:list";

export function createElectionRepository(redis) {
  return {
    async save(election) {
      await redis.set(electionKey(election.id), JSON.stringify(election));
      await redis.sadd(ELECTION_LIST, String(election.id));
    },

    async findById(id) {
      const raw = await redis.get(electionKey(id));
      if (!raw) return null;
      return JSON.parse(raw);
    },

    async list() {
      const ids = await redis.smembers(ELECTION_LIST);
      if (!ids.length) return [];
      const pipeline = redis.pipeline();
      for (const id of ids) pipeline.get(electionKey(id));
      const res = await pipeline.exec();
      return res
        .map(([err, raw]) => (err || !raw ? null : JSON.parse(raw)))
        .filter(Boolean)
        .sort((a, b) => Number(a.id) - Number(b.id));
    },

    async update(id, patch) {
      const current = await this.findById(id);
      if (!current) return null;
      const updated = { ...current, ...patch };
      await redis.set(electionKey(id), JSON.stringify(updated));
      return updated;
    },
  };
}
