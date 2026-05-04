const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// ---------------------------------------------------------------------------
// Constants matching the on-chain enum
// ---------------------------------------------------------------------------
const Status = {
  Created: 0n,
  Active: 1n,
  Closed: 2n,
};

// Helpers ---------------------------------------------------------------------

function metadataHash(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(`metadata:${label}`));
}

function commitmentFor(userId, electionId, salt = "salt") {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["string", "uint256", "string"],
      [userId, electionId, salt],
    ),
  );
}

function voteHashFor(choice, salt = "salt") {
  return ethers.keccak256(
    ethers.solidityPacked(["string", "string"], [choice, salt]),
  );
}

// Deploy fixture --------------------------------------------------------------

async function deployRegistry() {
  const [owner, alice, bob, carol] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("VotingRegistry");
  const registry = await Factory.deploy(owner.address);
  await registry.waitForDeployment();
  return { registry, owner, alice, bob, carol };
}

async function createDefaultElection(registry, owner, opts = {}) {
  const offsetStart = opts.offsetStart != null ? opts.offsetStart : 60; // 1 minute in the future
  const duration = opts.duration != null ? opts.duration : 3600; // 1 hour
  const label = opts.label || "election";
  const now = await time.latest();
  const startTime = now + offsetStart;
  const endTime = startTime + duration;
  const hash = metadataHash(label);

  const tx = await registry.connect(owner).createElection(hash, startTime, endTime);
  const receipt = await tx.wait();
  const electionId = (await registry.electionCount()) - 1n;
  return { electionId, startTime, endTime, hash, receipt };
}

// ---------------------------------------------------------------------------

describe("VotingRegistry", () => {
  describe("Deployment", () => {
    it("sets the deployer as initial owner", async () => {
      const { registry, owner } = await deployRegistry();
      expect(await registry.owner()).to.equal(owner.address);
    });

    it("starts with zero elections", async () => {
      const { registry } = await deployRegistry();
      expect(await registry.electionCount()).to.equal(0n);
    });

    it("reverts if deployed with zero address as owner", async () => {
      const Factory = await ethers.getContractFactory("VotingRegistry");
      await expect(Factory.deploy(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Factory, "OwnableInvalidOwner")
        .withArgs(ethers.ZeroAddress);
    });
  });

  describe("createElection", () => {
    it("creates an election and emits ElectionCreated", async () => {
      const { registry, owner } = await deployRegistry();
      const now = await time.latest();
      const startTime = now + 100;
      const endTime = startTime + 3600;
      const hash = metadataHash("first");

      await expect(registry.connect(owner).createElection(hash, startTime, endTime))
        .to.emit(registry, "ElectionCreated")
        .withArgs(0, hash, startTime, endTime);

      const e = await registry.getElection(0);
      expect(e.metadataHash).to.equal(hash);
      expect(e.startTime).to.equal(startTime);
      expect(e.endTime).to.equal(endTime);
      expect(e.totalVotes).to.equal(0n);
      expect(e.status).to.equal(Status.Created);
    });

    it("auto-increments election ids", async () => {
      const { registry, owner } = await deployRegistry();
      await createDefaultElection(registry, owner, { label: "a" });
      await createDefaultElection(registry, owner, { label: "b", offsetStart: 120 });
      await createDefaultElection(registry, owner, { label: "c", offsetStart: 180 });
      expect(await registry.electionCount()).to.equal(3n);
    });

    it("reverts when called by non-owner", async () => {
      const { registry, alice } = await deployRegistry();
      const now = await time.latest();
      await expect(
        registry
          .connect(alice)
          .createElection(metadataHash("x"), now + 60, now + 3600),
      )
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("reverts on zero metadata hash", async () => {
      const { registry, owner } = await deployRegistry();
      const now = await time.latest();
      await expect(
        registry.connect(owner).createElection(ethers.ZeroHash, now + 60, now + 3600),
      ).to.be.revertedWithCustomError(registry, "EmptyMetadataHash");
    });

    it("reverts when startTime >= endTime", async () => {
      const { registry, owner } = await deployRegistry();
      const now = await time.latest();
      await expect(
        registry.connect(owner).createElection(metadataHash("x"), now + 200, now + 100),
      ).to.be.revertedWithCustomError(registry, "InvalidTimeWindow");
      await expect(
        registry.connect(owner).createElection(metadataHash("x"), now + 200, now + 200),
      ).to.be.revertedWithCustomError(registry, "InvalidTimeWindow");
    });

    it("reverts when startTime is in the past", async () => {
      const { registry, owner } = await deployRegistry();
      const now = await time.latest();
      await expect(
        registry.connect(owner).createElection(metadataHash("x"), now - 10, now + 3600),
      ).to.be.revertedWithCustomError(registry, "StartTimeInPast");
    });
  });

  describe("openElection", () => {
    it("moves startTime to now and emits ElectionOpened", async () => {
      const { registry, owner } = await deployRegistry();
      const { electionId } = await createDefaultElection(registry, owner, {
        offsetStart: 600,
      });

      const tx = await registry.connect(owner).openElection(electionId);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      await expect(tx)
        .to.emit(registry, "ElectionOpened")
        .withArgs(electionId, block.timestamp);

      expect(await registry.getStatus(electionId)).to.equal(Status.Active);
    });

    it("reverts when called by non-owner", async () => {
      const { registry, owner, alice } = await deployRegistry();
      const { electionId } = await createDefaultElection(registry, owner);
      await expect(registry.connect(alice).openElection(electionId))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("reverts if the election does not exist", async () => {
      const { registry, owner } = await deployRegistry();
      await expect(registry.connect(owner).openElection(42))
        .to.be.revertedWithCustomError(registry, "ElectionNotFound")
        .withArgs(42);
    });

    it("reverts if the election has already started", async () => {
      const { registry, owner } = await deployRegistry();
      const { electionId, startTime } = await createDefaultElection(registry, owner);
      await time.increaseTo(startTime + 1);
      await expect(registry.connect(owner).openElection(electionId))
        .to.be.revertedWithCustomError(registry, "ElectionAlreadyStarted")
        .withArgs(electionId);
    });

    it("reverts if the election is already manually closed", async () => {
      const { registry, owner } = await deployRegistry();
      const { electionId } = await createDefaultElection(registry, owner);
      await registry.connect(owner).closeElection(electionId);
      await expect(registry.connect(owner).openElection(electionId))
        .to.be.revertedWithCustomError(registry, "ElectionAlreadyClosed")
        .withArgs(electionId);
    });
  });

  describe("closeElection", () => {
    it("manually closes an active election and emits ElectionClosed", async () => {
      const { registry, owner } = await deployRegistry();
      const { electionId, startTime } = await createDefaultElection(registry, owner);
      await time.increaseTo(startTime + 10);

      const tx = await registry.connect(owner).closeElection(electionId);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      await expect(tx)
        .to.emit(registry, "ElectionClosed")
        .withArgs(electionId, block.timestamp);

      expect(await registry.getStatus(electionId)).to.equal(Status.Closed);
    });

    it("can close a not-yet-started election", async () => {
      const { registry, owner } = await deployRegistry();
      const { electionId } = await createDefaultElection(registry, owner);
      expect(await registry.getStatus(electionId)).to.equal(Status.Created);
      await registry.connect(owner).closeElection(electionId);
      expect(await registry.getStatus(electionId)).to.equal(Status.Closed);
    });

    it("reverts when called by non-owner", async () => {
      const { registry, owner, alice } = await deployRegistry();
      const { electionId } = await createDefaultElection(registry, owner);
      await expect(registry.connect(alice).closeElection(electionId))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
        .withArgs(alice.address);
    });

    it("reverts if already manually closed", async () => {
      const { registry, owner } = await deployRegistry();
      const { electionId } = await createDefaultElection(registry, owner);
      await registry.connect(owner).closeElection(electionId);
      await expect(registry.connect(owner).closeElection(electionId))
        .to.be.revertedWithCustomError(registry, "ElectionAlreadyClosed")
        .withArgs(electionId);
    });

    it("reverts if the election does not exist", async () => {
      const { registry, owner } = await deployRegistry();
      await expect(registry.connect(owner).closeElection(0))
        .to.be.revertedWithCustomError(registry, "ElectionNotFound")
        .withArgs(0);
    });
  });

  describe("castVote", () => {
    it("registers a valid vote, increments totalVotes and emits VoteCast", async () => {
      const { registry, owner, alice } = await deployRegistry();
      const { electionId, startTime } = await createDefaultElection(registry, owner);
      await time.increaseTo(startTime + 1);

      const commitment = commitmentFor("alice", electionId);
      const vote = voteHashFor("YES");

      const tx = await registry.connect(alice).castVote(electionId, commitment, vote);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      await expect(tx)
        .to.emit(registry, "VoteCast")
        .withArgs(electionId, commitment, vote, block.timestamp);

      expect(await registry.hasUserVoted(electionId, commitment)).to.equal(true);
      const e = await registry.getElection(electionId);
      expect(e.totalVotes).to.equal(1n);
    });

    it("supports many distinct voters in the same election", async () => {
      const { registry, owner, alice, bob, carol } = await deployRegistry();
      const { electionId, startTime } = await createDefaultElection(registry, owner);
      await time.increaseTo(startTime + 1);

      const voters = [
        [alice, "alice"],
        [bob, "bob"],
        [carol, "carol"],
      ];
      for (const [signer, user] of voters) {
        await registry
          .connect(signer)
          .castVote(electionId, commitmentFor(user, electionId), voteHashFor("A"));
      }

      const e = await registry.getElection(electionId);
      expect(e.totalVotes).to.equal(3n);
    });

    it("rejects a double vote from the same commitment", async () => {
      const { registry, owner, alice, bob } = await deployRegistry();
      const { electionId, startTime } = await createDefaultElection(registry, owner);
      await time.increaseTo(startTime + 1);

      const commitment = commitmentFor("alice", electionId);
      await registry.connect(alice).castVote(electionId, commitment, voteHashFor("A"));

      // Even from a different EOA, the same commitment cannot vote twice.
      await expect(
        registry.connect(bob).castVote(electionId, commitment, voteHashFor("B")),
      )
        .to.be.revertedWithCustomError(registry, "AlreadyVoted")
        .withArgs(electionId, commitment);

      const e = await registry.getElection(electionId);
      expect(e.totalVotes).to.equal(1n);
    });

    it("rejects votes before startTime (status Created)", async () => {
      const { registry, owner, alice } = await deployRegistry();
      const { electionId } = await createDefaultElection(registry, owner);
      await expect(
        registry
          .connect(alice)
          .castVote(electionId, commitmentFor("alice", electionId), voteHashFor("A")),
      )
        .to.be.revertedWithCustomError(registry, "ElectionNotActive")
        .withArgs(electionId, Status.Created);
    });

    it("rejects votes after endTime (status Closed)", async () => {
      const { registry, owner, alice } = await deployRegistry();
      const { electionId, endTime } = await createDefaultElection(registry, owner);
      await time.increaseTo(endTime + 1);
      await expect(
        registry
          .connect(alice)
          .castVote(electionId, commitmentFor("alice", electionId), voteHashFor("A")),
      )
        .to.be.revertedWithCustomError(registry, "ElectionNotActive")
        .withArgs(electionId, Status.Closed);
    });

    it("rejects votes after manual closure", async () => {
      const { registry, owner, alice } = await deployRegistry();
      const { electionId, startTime } = await createDefaultElection(registry, owner);
      await time.increaseTo(startTime + 1);
      await registry.connect(owner).closeElection(electionId);

      await expect(
        registry
          .connect(alice)
          .castVote(electionId, commitmentFor("alice", electionId), voteHashFor("A")),
      )
        .to.be.revertedWithCustomError(registry, "ElectionNotActive")
        .withArgs(electionId, Status.Closed);
    });

    it("rejects empty commitment or vote hash", async () => {
      const { registry, owner, alice } = await deployRegistry();
      const { electionId, startTime } = await createDefaultElection(registry, owner);
      await time.increaseTo(startTime + 1);

      await expect(
        registry.connect(alice).castVote(electionId, ethers.ZeroHash, voteHashFor("A")),
      ).to.be.revertedWithCustomError(registry, "EmptyVoterCommitment");

      await expect(
        registry
          .connect(alice)
          .castVote(electionId, commitmentFor("alice", electionId), ethers.ZeroHash),
      ).to.be.revertedWithCustomError(registry, "EmptyVoteHash");
    });

    it("rejects votes for non-existent elections", async () => {
      const { registry, alice } = await deployRegistry();
      await expect(
        registry
          .connect(alice)
          .castVote(99, commitmentFor("alice", 99n), voteHashFor("A")),
      )
        .to.be.revertedWithCustomError(registry, "ElectionNotFound")
        .withArgs(99);
    });
  });

  describe("Status transitions over time", () => {
    it("walks Created -> Active -> Closed without manual intervention", async () => {
      const { registry, owner } = await deployRegistry();
      const { electionId, startTime, endTime } = await createDefaultElection(
        registry,
        owner,
      );
      expect(await registry.getStatus(electionId)).to.equal(Status.Created);
      await time.increaseTo(startTime + 1);
      expect(await registry.getStatus(electionId)).to.equal(Status.Active);
      await time.increaseTo(endTime + 1);
      expect(await registry.getStatus(electionId)).to.equal(Status.Closed);
    });
  });

  describe("Ownership transfer", () => {
    it("allows the new owner to administer after transferOwnership", async () => {
      const { registry, owner, alice } = await deployRegistry();
      await registry.connect(owner).transferOwnership(alice.address);
      expect(await registry.owner()).to.equal(alice.address);

      const now = await time.latest();
      await expect(
        registry
          .connect(alice)
          .createElection(metadataHash("after-transfer"), now + 60, now + 3600),
      ).to.emit(registry, "ElectionCreated");

      // Old owner can no longer administer.
      await expect(
        registry
          .connect(owner)
          .createElection(metadataHash("denied"), now + 120, now + 3600),
      )
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
        .withArgs(owner.address);
    });
  });
});
