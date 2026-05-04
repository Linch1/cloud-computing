import { metadataHash as hashMetadata } from "../utils/hash.js";
import { badRequest, notFound, conflict } from "../utils/errors.js";

const STATUS_LABELS = ["created", "active", "closed"];

export function createElectionService({ elections, chain }) {
  return {
    /**
     * Creates an election on-chain and stores the off-chain metadata.
     * @param {{title:string, description:string, options:string[],
     *          startTime:number, endTime:number}} input  unix seconds
     * @param {{id:string,email:string}} createdBy
     */
    async create(input, createdBy) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (input.startTime <= nowSec) {
        throw badRequest("INVALID_TIME_WINDOW", "startTime must be in the future");
      }
      if (input.endTime <= input.startTime) {
        throw badRequest("INVALID_TIME_WINDOW", "endTime must be greater than startTime");
      }

      const metadata = {
        title: input.title,
        description: input.description,
        options: input.options,
        startTime: input.startTime,
        endTime: input.endTime,
      };
      const mHash = hashMetadata(metadata);

      const { txHash, blockNumber, electionId } = await chain.createElection(
        mHash,
        BigInt(input.startTime),
        BigInt(input.endTime)
      );

      if (electionId === null || electionId === undefined) {
        throw new Error("On-chain transaction did not emit ElectionCreated");
      }

      const election = {
        id: String(electionId),
        title: input.title,
        description: input.description,
        options: input.options,
        startTime: input.startTime,
        endTime: input.endTime,
        metadataHash: mHash,
        manuallyClosed: false,
        createdBy: { id: createdBy.id, email: createdBy.email },
        createdAt: new Date().toISOString(),
        txHash,
        blockNumber,
      };
      await elections.save(election);
      return election;
    },

    async open(electionId) {
      const election = await elections.findById(electionId);
      if (!election) throw notFound("ELECTION_NOT_FOUND", `Election ${electionId} not found`);
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= election.startTime) {
        throw conflict("ELECTION_ALREADY_STARTED", "Election has already started");
      }
      const { txHash, blockNumber } = await chain.openElection(electionId);
      const updated = await elections.update(electionId, {
        startTime: nowSec,
        openedTxHash: txHash,
        openedBlockNumber: blockNumber,
      });
      return updated;
    },

    async close(electionId) {
      const election = await elections.findById(electionId);
      if (!election) throw notFound("ELECTION_NOT_FOUND", `Election ${electionId} not found`);
      if (election.manuallyClosed) {
        throw conflict("ELECTION_ALREADY_CLOSED", "Election is already closed");
      }
      const { txHash, blockNumber } = await chain.closeElection(electionId);
      const updated = await elections.update(electionId, {
        manuallyClosed: true,
        endTime: Math.floor(Date.now() / 1000),
        closedTxHash: txHash,
        closedBlockNumber: blockNumber,
      });
      return updated;
    },

    async list() {
      const all = await elections.list();
      return all.map(toPublic);
    },

    async getById(electionId) {
      const e = await elections.findById(electionId);
      if (!e) throw notFound("ELECTION_NOT_FOUND", `Election ${electionId} not found`);
      return toPublic(e);
    },

    /**
     * Returns the live status combining on-chain truth (status, totalVotes)
     * with off-chain metadata. Falls back to local data if the RPC fails.
     */
    async getStatus(electionId) {
      const e = await elections.findById(electionId);
      if (!e) throw notFound("ELECTION_NOT_FOUND", `Election ${electionId} not found`);
      try {
        const onchain = await chain.getElection(electionId);
        return {
          id: e.id,
          status: STATUS_LABELS[onchain.status] ?? "unknown",
          totalVotes: onchain.totalVotes,
          startTime: onchain.startTime,
          endTime: onchain.endTime,
          metadataHash: onchain.metadataHash,
          metadataMatches: onchain.metadataHash.toLowerCase() === e.metadataHash.toLowerCase(),
        };
      } catch (err) {
        return {
          id: e.id,
          status: deriveLocalStatus(e),
          totalVotes: null,
          startTime: e.startTime,
          endTime: e.endTime,
          metadataHash: e.metadataHash,
          metadataMatches: null,
          chainError: err.message,
        };
      }
    },
  };
}

function toPublic(e) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    options: e.options,
    startTime: e.startTime,
    endTime: e.endTime,
    metadataHash: e.metadataHash,
    manuallyClosed: e.manuallyClosed,
    createdAt: e.createdAt,
    txHash: e.txHash,
    status: deriveLocalStatus(e),
  };
}

function deriveLocalStatus(e) {
  if (e.manuallyClosed) return "closed";
  const now = Math.floor(Date.now() / 1000);
  if (now < e.startTime) return "created";
  if (now <= e.endTime) return "active";
  return "closed";
}
