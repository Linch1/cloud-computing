import fp from "fastify-plugin";
import { ethers } from "ethers";
import abi from "../abi/VotingRegistry.json" with { type: "json" };

/**
 * Decorates the Fastify instance with a `chain` object exposing the
 * relayer wallet, the contract instance and a small set of high-level
 * helpers used by the services.
 *
 * Tests can fully bypass this plugin by providing `opts.client`, an
 * object that mimics the same surface (see test/helpers).
 */
export default fp(async function blockchainPlugin(app, opts) {
  if (opts.client) {
    app.decorate("chain", opts.client);
    return;
  }

  const provider = new ethers.JsonRpcProvider(app.config.RPC_URL, {
    chainId: app.config.CHAIN_ID,
    name: `chain-${app.config.CHAIN_ID}`,
  });
  const wallet = new ethers.Wallet(app.config.PRIVATE_KEY, provider);
  const contract = new ethers.Contract(app.config.CONTRACT_ADDRESS, abi, wallet);

  const chain = {
    provider,
    wallet,
    contract,

    /**
     * @param {string} metadataHash bytes32
     * @param {bigint} startTime    unix seconds
     * @param {bigint} endTime      unix seconds
     */
    async createElection(metadataHash, startTime, endTime) {
      const tx = await contract.createElection(metadataHash, startTime, endTime);
      const receipt = await tx.wait();
      let electionId = null;
      for (const log of receipt.logs) {
        try {
          const parsed = contract.interface.parseLog(log);
          if (parsed && parsed.name === "ElectionCreated") {
            electionId = parsed.args.electionId.toString();
            break;
          }
        } catch {
          // not from our contract, ignore
        }
      }
      return { txHash: receipt.hash, blockNumber: receipt.blockNumber, electionId };
    },

    async openElection(electionId) {
      const tx = await contract.openElection(BigInt(electionId));
      const receipt = await tx.wait();
      return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
    },

    async closeElection(electionId) {
      const tx = await contract.closeElection(BigInt(electionId));
      const receipt = await tx.wait();
      return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
    },

    async castVote(electionId, voterCommitmentHash, voteHash) {
      const tx = await contract.castVote(
        BigInt(electionId),
        voterCommitmentHash,
        voteHash
      );
      const receipt = await tx.wait();
      return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
    },

    async getElection(electionId) {
      const r = await contract.getElection(BigInt(electionId));
      return {
        metadataHash: r[0],
        startTime: Number(r[1]),
        endTime: Number(r[2]),
        totalVotes: Number(r[3]),
        status: Number(r[4]),
      };
    },

    async getStatus(electionId) {
      const s = await contract.getStatus(BigInt(electionId));
      return Number(s);
    },

    async hasUserVoted(electionId, voterCommitmentHash) {
      return await contract.hasUserVoted(BigInt(electionId), voterCommitmentHash);
    },
  };

  app.decorate("chain", chain);
});
