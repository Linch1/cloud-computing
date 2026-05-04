import { ethers } from "ethers";

/**
 * In-memory implementation of the chain client surface used by services.
 * Mirrors the behavior of `VotingRegistry` closely enough for the backend
 * tests (lifecycle, status transitions, double-vote prevention).
 */
export function createMockChain() {
  const elections = new Map();
  const voted = new Map();
  let nextId = 0;

  const STATUS = { CREATED: 0, ACTIVE: 1, CLOSED: 2 };

  const computeStatus = (e) => {
    const now = Math.floor(Date.now() / 1000);
    if (e.manuallyClosed) return STATUS.CLOSED;
    if (now < e.startTime) return STATUS.CREATED;
    if (now <= e.endTime) return STATUS.ACTIVE;
    return STATUS.CLOSED;
  };

  const fakeTx = () => ({
    txHash: "0x" + ethers.hexlify(ethers.randomBytes(32)).slice(2),
    blockNumber: Math.floor(Math.random() * 1_000_000) + 1,
  });

  return {
    _state: { elections, voted },

    async createElection(metadataHash, startTime, endTime) {
      const id = String(nextId++);
      elections.set(id, {
        id,
        metadataHash,
        startTime: Number(startTime),
        endTime: Number(endTime),
        manuallyClosed: false,
        totalVotes: 0,
      });
      return { ...fakeTx(), electionId: id };
    },

    async openElection(electionId) {
      const e = elections.get(String(electionId));
      if (!e) throw new Error("ElectionNotFound");
      if (e.manuallyClosed) throw new Error("ElectionAlreadyClosed");
      const now = Math.floor(Date.now() / 1000);
      if (now >= e.startTime) throw new Error("ElectionAlreadyStarted");
      e.startTime = now;
      return fakeTx();
    },

    async closeElection(electionId) {
      const e = elections.get(String(electionId));
      if (!e) throw new Error("ElectionNotFound");
      if (e.manuallyClosed) throw new Error("ElectionAlreadyClosed");
      e.manuallyClosed = true;
      const now = Math.floor(Date.now() / 1000);
      if (now < e.endTime) e.endTime = now;
      return fakeTx();
    },

    async castVote(electionId, voterCommitmentHash, voteHash) {
      const e = elections.get(String(electionId));
      if (!e) throw new Error("ElectionNotFound");
      const status = computeStatus(e);
      if (status !== STATUS.ACTIVE) throw new Error("ElectionNotActive");
      const key = `${electionId}:${voterCommitmentHash}`;
      if (voted.get(key)) throw new Error("AlreadyVoted");
      voted.set(key, voteHash);
      e.totalVotes += 1;
      return fakeTx();
    },

    async getElection(electionId) {
      const e = elections.get(String(electionId));
      if (!e) throw new Error("ElectionNotFound");
      return {
        metadataHash: e.metadataHash,
        startTime: e.startTime,
        endTime: e.endTime,
        totalVotes: e.totalVotes,
        status: computeStatus(e),
      };
    },

    async getStatus(electionId) {
      const e = elections.get(String(electionId));
      if (!e) throw new Error("ElectionNotFound");
      return computeStatus(e);
    },

    async hasUserVoted(electionId, voterCommitmentHash) {
      return voted.has(`${electionId}:${voterCommitmentHash}`);
    },
  };
}
