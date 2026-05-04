// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title VotingRegistry
 * @notice On-chain registry for elections and votes used by the secure online
 *         voting platform. The contract intentionally stores only opaque
 *         hashes (`metadataHash`, `voterCommitmentHash`, `voteHash`) so that
 *         no personal data, no vote content and no voter identity ever lives
 *         on-chain. The off-chain backend is responsible for binding those
 *         hashes back to real-world identities and choices in a controlled
 *         and auditable way.
 *
 * @dev    Election lifecycle is time-driven: the {ElectionStatus} returned
 *         by {getStatus} is computed from the current block timestamp and the
 *         configured `startTime` / `endTime`, with an additional manual
 *         override (`manuallyClosed`) the owner can use as an emergency stop.
 *         The owner can also "open early" an election whose `startTime` lies
 *         in the future via {openElection}.
 */
contract VotingRegistry is Ownable {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Lifecycle status of an election.
    enum ElectionStatus {
        Created, // before startTime
        Active, // between startTime and endTime, not manually closed
        Closed // after endTime, or manually closed by the owner
    }

    /**
     * @notice Election storage layout.
     * @dev    `metadataHash` is expected to be the keccak256 of the off-chain
     *         metadata document (title, description, options, ...). The
     *         backend keeps the original document and can prove its integrity
     *         by re-hashing it and comparing against this value.
     */
    struct Election {
        bytes32 metadataHash;
        uint64 startTime;
        uint64 endTime;
        uint128 totalVotes;
        bool manuallyClosed;
        bool exists;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @dev Sequential id assigned to the next created election.
    uint256 private _nextElectionId;

    /// @dev electionId => election data.
    mapping(uint256 => Election) private _elections;

    /// @dev electionId => voterCommitmentHash => has voted.
    mapping(uint256 => mapping(bytes32 => bool)) private _hasVoted;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted when a new election is created by the owner.
    event ElectionCreated(
        uint256 indexed electionId,
        bytes32 indexed metadataHash,
        uint64 startTime,
        uint64 endTime
    );

    /// @notice Emitted when the owner opens an election early.
    event ElectionOpened(uint256 indexed electionId, uint64 newStartTime);

    /// @notice Emitted when the owner closes an election (manual override).
    event ElectionClosed(uint256 indexed electionId, uint64 closedAt);

    /// @notice Emitted for every successful vote. Provides the audit trail.
    event VoteCast(
        uint256 indexed electionId,
        bytes32 indexed voterCommitmentHash,
        bytes32 voteHash,
        uint64 timestamp
    );

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error InvalidTimeWindow(uint64 startTime, uint64 endTime);
    error StartTimeInPast(uint64 startTime, uint64 nowTs);
    error EmptyMetadataHash();
    error ElectionNotFound(uint256 electionId);
    error ElectionAlreadyStarted(uint256 electionId);
    error ElectionAlreadyClosed(uint256 electionId);
    error ElectionNotActive(uint256 electionId, ElectionStatus status);
    error EmptyVoterCommitment();
    error EmptyVoteHash();
    error AlreadyVoted(uint256 electionId, bytes32 voterCommitmentHash);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @param initialOwner Address that will be granted ownership of the
     *        registry (typically the platform admin / deployer EOA or a
     *        multisig). Reverts if zero, per OpenZeppelin v5 Ownable.
     */
    constructor(address initialOwner) Ownable(initialOwner) {}

    // ---------------------------------------------------------------------
    // Admin: election lifecycle
    // ---------------------------------------------------------------------

    /**
     * @notice Creates a new election with the given metadata hash and time
     *         window. Only callable by the owner.
     * @param  metadataHash keccak256 of the off-chain metadata document
     *         (must not be zero).
     * @param  startTime    Unix timestamp at which the election becomes
     *         {ElectionStatus.Active}. Must be strictly in the future.
     * @param  endTime      Unix timestamp at which the election becomes
     *         {ElectionStatus.Closed}. Must be strictly greater than
     *         `startTime`.
     * @return electionId   The id assigned to the freshly created election.
     */
    function createElection(
        bytes32 metadataHash,
        uint256 startTime,
        uint256 endTime
    ) external onlyOwner returns (uint256 electionId) {
        if (metadataHash == bytes32(0)) revert EmptyMetadataHash();
        if (startTime >= endTime) revert InvalidTimeWindow(uint64(startTime), uint64(endTime));
        if (startTime <= block.timestamp) {
            revert StartTimeInPast(uint64(startTime), uint64(block.timestamp));
        }
        if (endTime > type(uint64).max) revert InvalidTimeWindow(uint64(startTime), uint64(endTime));

        electionId = _nextElectionId;
        unchecked {
            _nextElectionId = electionId + 1;
        }

        _elections[electionId] = Election({
            metadataHash: metadataHash,
            startTime: uint64(startTime),
            endTime: uint64(endTime),
            totalVotes: 0,
            manuallyClosed: false,
            exists: true
        });

        emit ElectionCreated(electionId, metadataHash, uint64(startTime), uint64(endTime));
    }

    /**
     * @notice Opens an election early by moving its `startTime` to the
     *         current block timestamp. The election must exist, must not
     *         have started yet and must not be manually closed.
     * @dev    Useful for the admin dashboard "open now" action while keeping
     *         the contract time-driven by default.
     */
    function openElection(uint256 electionId) external onlyOwner {
        Election storage e = _getExisting(electionId);
        if (e.manuallyClosed) revert ElectionAlreadyClosed(electionId);
        if (block.timestamp >= e.startTime) revert ElectionAlreadyStarted(electionId);

        uint64 newStart = uint64(block.timestamp);
        e.startTime = newStart;

        emit ElectionOpened(electionId, newStart);
    }

    /**
     * @notice Manually closes an election. After this call {getStatus} will
     *         always return {ElectionStatus.Closed} and {castVote} will be
     *         rejected, regardless of `endTime`.
     */
    function closeElection(uint256 electionId) external onlyOwner {
        Election storage e = _getExisting(electionId);
        if (e.manuallyClosed) revert ElectionAlreadyClosed(electionId);

        e.manuallyClosed = true;
        // Snap endTime to "now" if we're closing before it, so that
        // off-chain consumers that only inspect the time window also see
        // the election as closed.
        if (block.timestamp < e.endTime) {
            e.endTime = uint64(block.timestamp);
        }

        emit ElectionClosed(electionId, uint64(block.timestamp));
    }

    // ---------------------------------------------------------------------
    // Voting
    // ---------------------------------------------------------------------

    /**
     * @notice Casts a vote for the given election. The contract only stores
     *         the `voterCommitmentHash` (uniqueness key) and the `voteHash`
     *         (opaque ballot). The mapping between these hashes and the
     *         underlying user / choice is kept off-chain by the backend.
     *
     * @param  electionId           Target election.
     * @param  voterCommitmentHash  Commitment that uniquely identifies the
     *         voter for this election (e.g. keccak256(userId, electionId,
     *         salt)). Reused across calls -> AlreadyVoted.
     * @param  voteHash             Hash of the ballot content
     *         (e.g. keccak256(choice, salt)). Must be non-zero.
     */
    function castVote(
        uint256 electionId,
        bytes32 voterCommitmentHash,
        bytes32 voteHash
    ) external {
        if (voterCommitmentHash == bytes32(0)) revert EmptyVoterCommitment();
        if (voteHash == bytes32(0)) revert EmptyVoteHash();

        Election storage e = _getExisting(electionId);
        ElectionStatus status = _statusOf(e);
        if (status != ElectionStatus.Active) revert ElectionNotActive(electionId, status);

        if (_hasVoted[electionId][voterCommitmentHash]) {
            revert AlreadyVoted(electionId, voterCommitmentHash);
        }
        _hasVoted[electionId][voterCommitmentHash] = true;

        unchecked {
            // totalVotes is uint128, overflow is practically impossible.
            e.totalVotes = e.totalVotes + 1;
        }

        emit VoteCast(electionId, voterCommitmentHash, voteHash, uint64(block.timestamp));
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Returns true iff the given commitment has already voted.
    function hasUserVoted(uint256 electionId, bytes32 voterCommitmentHash)
        external
        view
        returns (bool)
    {
        return _hasVoted[electionId][voterCommitmentHash];
    }

    /**
     * @notice Returns the full election record together with its computed
     *         status. Reverts if the election does not exist.
     */
    function getElection(uint256 electionId)
        external
        view
        returns (
            bytes32 metadataHash,
            uint64 startTime,
            uint64 endTime,
            uint128 totalVotes,
            ElectionStatus status
        )
    {
        Election storage e = _getExisting(electionId);
        return (e.metadataHash, e.startTime, e.endTime, e.totalVotes, _statusOf(e));
    }

    /// @notice Computed status of the given election.
    function getStatus(uint256 electionId) external view returns (ElectionStatus) {
        return _statusOf(_getExisting(electionId));
    }

    /// @notice Total number of elections created so far. Ids are 0-indexed.
    function electionCount() external view returns (uint256) {
        return _nextElectionId;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _getExisting(uint256 electionId) internal view returns (Election storage e) {
        e = _elections[electionId];
        if (!e.exists) revert ElectionNotFound(electionId);
    }

    function _statusOf(Election storage e) internal view returns (ElectionStatus) {
        if (e.manuallyClosed) return ElectionStatus.Closed;
        if (block.timestamp < e.startTime) return ElectionStatus.Created;
        if (block.timestamp <= e.endTime) return ElectionStatus.Active;
        return ElectionStatus.Closed;
    }
}
