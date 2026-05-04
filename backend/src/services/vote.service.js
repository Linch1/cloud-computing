import {
  voterCommitmentHash as buildVoterCommitment,
  voteHash as buildVoteHash,
  randomNonce,
} from "../utils/hash.js";
import { badRequest, conflict, notFound } from "../utils/errors.js";

const STATUS_ACTIVE = 1;

export function createVoteService({ elections, votes, chain, salt }) {
  return {
    /**
     * Cast a vote on behalf of `user` for `electionId`. The whole flow is
     * protected by a Redis lock to prevent race conditions and double
     * checked on-chain via `hasUserVoted`.
     *
     * @param {{id:string}} user
     * @param {string} electionId
     * @param {{selectedOption:number}} input
     */
    async castVote(user, electionId, input) {
      const election = await elections.findById(electionId);
      if (!election) {
        throw notFound("ELECTION_NOT_FOUND", `Election ${electionId} not found`);
      }
      if (
        input.selectedOption < 0 ||
        input.selectedOption >= election.options.length ||
        !Number.isInteger(input.selectedOption)
      ) {
        throw badRequest(
          "INVALID_OPTION",
          `selectedOption must be an integer in [0, ${election.options.length - 1}]`
        );
      }

      const locked = await votes.acquireLock(electionId, user.id, 30);
      if (!locked) {
        throw conflict("VOTE_IN_PROGRESS", "A vote is already being processed for this user");
      }
      try {
        const existing = await votes.findByUser(electionId, user.id);
        if (existing) {
          throw conflict("ALREADY_VOTED", "You have already voted in this election");
        }

        const voterCommitment = buildVoterCommitment(user.id, electionId, salt);

        const onchainVoted = await chain
          .hasUserVoted(electionId, voterCommitment)
          .catch(() => false);
        if (onchainVoted) {
          throw conflict("ALREADY_VOTED", "You have already voted in this election");
        }

        const status = await chain.getStatus(electionId).catch(() => null);
        if (status !== null && status !== STATUS_ACTIVE) {
          throw conflict("ELECTION_NOT_ACTIVE", "Election is not currently active");
        }

        const nonce = randomNonce();
        const vHash = buildVoteHash(electionId, input.selectedOption, nonce);

        const { txHash, blockNumber } = await chain.castVote(
          electionId,
          voterCommitment,
          vHash
        );

        const record = {
          electionId,
          userId: user.id,
          voterCommitmentHash: voterCommitment,
          voteHash: vHash,
          nonce,
          selectedOption: input.selectedOption,
          txHash,
          blockNumber,
          castAt: new Date().toISOString(),
        };
        await votes.save(electionId, user.id, record);

        return {
          electionId,
          txHash,
          blockNumber,
          voteHash: vHash,
          voterCommitmentHash: voterCommitment,
          castAt: record.castAt,
        };
      } finally {
        await votes.releaseLock(electionId, user.id);
      }
    },

    async getMyStatus(user, electionId) {
      const election = await elections.findById(electionId);
      if (!election) {
        throw notFound("ELECTION_NOT_FOUND", `Election ${electionId} not found`);
      }
      const local = await votes.findByUser(electionId, user.id);
      if (local) {
        return {
          electionId,
          hasVoted: true,
          source: "off-chain",
          txHash: local.txHash,
          voteHash: local.voteHash,
          castAt: local.castAt,
        };
      }
      const commitment = buildVoterCommitment(user.id, electionId, salt);
      const onchain = await chain.hasUserVoted(electionId, commitment).catch(() => null);
      return {
        electionId,
        hasVoted: onchain === true,
        source: onchain === null ? "unknown" : "on-chain",
      };
    },
  };
}
