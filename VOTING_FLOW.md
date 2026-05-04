# Voting Mechanism — Technical Deep Dive

This document explains, step by step, **exactly how a vote is cast** on
this platform. The short answer to your intuition is: **yes, the user
does NOT sign or send the on-chain transaction**. The user only
authenticates and clicks a button; the **backend** holds a single
private key (the *relayer*) and is the only entity that ever talks to
the blockchain.

This pattern is called **meta-transactions / relayed transactions**.
Below we reconstruct the full path from the click in the browser to
the `VoteCast` event on-chain.

---

## TL;DR

```
User (browser)                   Backend (Fastify + Redis)              VotingRegistry (Solidity)
──────────────                   ─────────────────────────              ────────────────────────
click "Confirm vote"
  │
  │  POST /elections/:id/vote    ───────────────►
  │  Authorization: Bearer JWT   { selectedOption }
  │                                       │
  │                                       │ 1. Auth (JWT) + role check
  │                                       │ 2. Validate option index
  │                                       │ 3. Redis lock NX EX 30
  │                                       │ 4. Off-chain double-vote check
  │                                       │ 5. Compute voterCommitmentHash
  │                                       │    = keccak256(userId|electionId|salt)
  │                                       │ 6. Pre-flight: hasUserVoted? getStatus?
  │                                       │ 7. Build voteHash
  │                                       │    = keccak256(electionId|option|nonce)
  │                                       │
  │                                       │ 8. Sign + send tx with relayer key  ──────────►
  │                                       │                                        castVote(
  │                                       │                                          electionId,
  │                                       │                                          voterCommitmentHash,
  │                                       │                                          voteHash)
  │                                       │                                            │
  │                                       │                                            │ • check non-zero hashes
  │                                       │                                            │ • check status == Active
  │                                       │                                            │ • check !hasVoted[id][cmt]
  │                                       │                                            │ • set hasVoted = true
  │                                       │                                            │ • totalVotes++
  │                                       │                                            │ • emit VoteCast
  │                                       │                       ◄──── tx receipt ────│
  │                                       │
  │                                       │ 9. Persist receipt in Redis
  │                                       │    vote:{electionId}:{userId} = {hashes, nonce, option, tx, block, castAt}
  │                                       │ 10. Release lock
  │
  │  201 Created                  ◄──────────
  │  { vote: { txHash, blockNumber, voteHash, voterCommitmentHash, castAt } }
  ▼
shows VoteReceipt
```

---

## 1. Why doesn't the user sign the transaction?

Three reasons, each load-bearing for the design:

1. **No wallet UX**. The platform is meant to feel like a normal web
   app: register with email + password, log in, click a button, vote.
   Asking voters to install MetaMask, fund their address, manage seed
   phrases, etc., would defeat the purpose.
2. **No personal data on-chain**. If the user signed, every transaction
   would carry their EOA address and that address would become a
   permanent, public, queryable identity. By having a *single* relayer
   sign all votes, the chain only sees opaque hashes — observers can
   *count* votes but cannot map them to people.
3. **Gas is paid by the platform**. The user never has to hold ETH /
   MATIC / etc. to participate.

The trade-off is **trust in the backend**. If the relayer is malicious
or compromised, it could refuse to broadcast some votes. It cannot,
however, alter or forge votes silently because:

- the contract still requires `status == Active` and rejects duplicate
  `voterCommitmentHash`,
- every vote is auditable on-chain via `VoteCast` events,
- the backend cannot reuse a `voterCommitmentHash` for a different
  user (the hash is deterministic in `userId | electionId | salt`).

---

## 2. The three hashes that make the system work

The whole privacy/integrity model hangs on three deterministic hashes.
All are computed off-chain and only their `bytes32` values reach the
contract.

### 2.1 `metadataHash` (per election, computed at creation)

```js
metadataHash = keccak256(canonicalJSON({
  title, description, options, startTime, endTime, ...
}))
```

- Canonical JSON: keys sorted recursively (`utils/hash.js#canonicalStringify`).
- Stored both on-chain (in `Election.metadataHash`) and off-chain (in
  Redis as the original document).
- Lets the backend / a third party prove later that the election text
  has not been tampered with by re-hashing the off-chain doc and
  comparing it to the on-chain value. The frontend exposes this as
  the `metadata verified` / `metadata mismatch` badge.

### 2.2 `voterCommitmentHash` (per user, per election — deterministic)

```js
// backend/src/utils/hash.js
voterCommitmentHash = keccak256(`${userId}|${electionId}|${salt}`)
```

- `userId` is a ULID stored in Redis under `user:{userId}`.
- `electionId` is the integer assigned by the contract at creation.
- `salt` is `VOTER_HASH_SALT` from `backend/.env` — a server secret,
  ≥ 32 chars, never logged, never returned in any API response.
- This hash is the **uniqueness key** the contract uses to enforce
  "one vote per user per election" via
  `mapping(uint256 => mapping(bytes32 => bool)) _hasVoted`.
- It is **deterministic**: re-computing it for the same user gives
  the same value, which is precisely what allows the contract to
  reject duplicates and what allows the backend to query
  `hasUserVoted(electionId, commitment)` later (e.g. to render
  "you already voted" even after a Redis wipe).
- It is **opaque** to anyone who doesn't know the salt. Without the
  salt, observers see an unlinkable 32-byte blob — they cannot
  enumerate the user space and brute-force a mapping back to user
  IDs.

### 2.3 `voteHash` (per vote — non-deterministic)

```js
nonce    = randomBytes(32)              // fresh, 32 bytes, hex
voteHash = keccak256(`${electionId}|${selectedOption}|${nonce}`)
```

- The `nonce` is generated **at vote time** with `ethers.randomBytes(32)`
  and stored in Redis alongside the vote record.
- Without the nonce, an observer could brute-force tiny option sets
  (e.g. *yes* / *no* — only two pre-images, both trivially testable).
  With a 32-byte nonce, the hash is computationally indistinguishable
  from random.
- The nonce is **secret** (Redis only). The hash is **public**
  (on-chain, indexed in `VoteCast`). If the platform ever needs to
  prove what a user voted, it can reveal `(electionId, option, nonce)`
  and any third party can check `keccak256(...) == voteHash`.

> The on-chain vote is therefore a **commitment**, not a recorded
> ballot. Tally is performed off-chain by the backend, which alone
> knows `selectedOption`. Anyone can however count *how many* votes
> there are by counting `VoteCast` events.

---

## 3. The actors and their keys

| Actor               | Has a private key? | Where it lives                  |
| ------------------- | ------------------ | ------------------------------- |
| Voter               | **No**             | only an email + password (bcrypt-hashed in Redis) |
| Admin               | **No**             | same as voter                   |
| Backend (*relayer*) | **Yes — one**      | `PRIVATE_KEY` in `backend/.env` |
| Smart contract      | n/a                | `CONTRACT_ADDRESS` in `backend/.env` |

The relayer key **must equal the contract `owner`** (set at deploy
time). Otherwise admin-only calls (`createElection`, `openElection`,
`closeElection`) revert with `OwnableUnauthorizedAccount`. Note that
`castVote` itself is callable by anyone — but in this platform we keep
funneling everything through the same relayer key for simplicity and
to make the on-chain footprint uniform.

---

## 4. Step-by-step, exactly what happens when you click "Confirm vote"

### 4.1 Frontend — `lib/api.js` + `VoteForm.jsx`

```js
await api.vote(electionId, selectedOption);
// → fetch(`${NEXT_PUBLIC_API_URL}/elections/${electionId}/vote`, {
//     method: "POST",
//     headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
//     body: JSON.stringify({ selectedOption })
//   })
```

The frontend does **not** know:

- the `voterCommitmentHash` (depends on the secret salt),
- the `voteHash` (depends on the per-vote nonce, generated server-side),
- the relayer's private key,
- the contract address,
- the RPC URL.

It only knows the chosen index and its JWT.

### 4.2 Route — `routes/votes.routes.js`

```js
app.addHook("preHandler", app.authenticate);   // verifies JWT, sets req.user

app.post("/elections/:id/vote",
  { config: { rateLimit: { /* per-user limit */ }}},
  async (req, reply) => {
    if (req.user.role !== "voter" && req.user.role !== "admin") throw forbidden(...);
    const { id } = electionIdParam.parse(req.params);
    const body   = castVoteSchema.parse(req.body);   // { selectedOption: int }
    const result = await voteService.castVote({ id: req.user.sub }, id, body);
    return reply.code(201).send({ vote: result });
  });
```

Things enforced here, **before** the service runs:

1. **JWT validity** (`@fastify/jwt` decoder).
2. **Role** = voter or admin.
3. **Per-user rate limit** (key = `vote:<userId>`, window
   `RATE_LIMIT_VOTE_WINDOW`, max `RATE_LIMIT_VOTE_MAX`).
4. **Schema validation** of params and body via Zod.

### 4.3 Service — `services/vote.service.js`

In order:

1. **Load election from Redis**. Reject with `ELECTION_NOT_FOUND` if
   missing.
2. **Validate option index** is an integer in `[0, options.length-1]`
   (semantic check on top of the Zod check).
3. **Acquire a Redis lock** with `SET lock:vote:{election}:{user} 1
   EX 30 NX`. If the lock already exists → `409 VOTE_IN_PROGRESS`.
   This prevents the user from launching two parallel `castVote` HTTP
   calls.
4. **Off-chain double-vote check**: `GET vote:{election}:{user}`. If
   it exists → `409 ALREADY_VOTED`.
5. **Compute the voter commitment**:
   `keccak256("{userId}|{electionId}|{salt}")`.
6. **On-chain pre-flight**:
   - `hasUserVoted(electionId, commitment)` — protects against the
     case where Redis was wiped but the chain remembers. If on-chain
     says yes → `409 ALREADY_VOTED`.
   - `getStatus(electionId)` — must equal `Active (1)`. Otherwise
     `409 ELECTION_NOT_ACTIVE`. This is purely for fast UX feedback;
     the contract will re-check anyway.
7. **Build the ballot hash**:
   - `nonce = randomBytes(32)` → `0x...` (hex),
   - `voteHash = keccak256("{electionId}|{option}|{nonce}")`.
8. **Send the transaction** through `app.chain.castVote(...)` (see
   §4.4). Wait for the receipt.
9. **Persist the receipt** in Redis at `vote:{electionId}:{userId}`:
   ```json
   {
     "electionId": "...",
     "userId":     "...",
     "voterCommitmentHash": "0x...",
     "voteHash":            "0x...",
     "nonce":               "0x...",
     "selectedOption":      1,
     "txHash":              "0x...",
     "blockNumber":         42,
     "castAt":              "2026-05-01T22:00:00.000Z"
   }
   ```
10. **Release the lock** in a `finally` block (so it is always
    released, even on exceptions).
11. Return to the route a redacted view (`{ txHash, blockNumber,
    voteHash, voterCommitmentHash, castAt }`). Note that the
    `selectedOption` and the `nonce` are **not** returned.

### 4.4 Blockchain plugin — `plugins/blockchain.js`

```js
const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID });
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

async castVote(electionId, voterCommitmentHash, voteHash) {
  const tx = await contract.castVote(BigInt(electionId), voterCommitmentHash, voteHash);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}
```

This is the only point in the codebase where the relayer's private
key is used. The wallet:

- Auto-fetches the next nonce from the chain.
- Auto-estimates gas, signs the transaction with `PRIVATE_KEY`,
  broadcasts it via the provider's `eth_sendRawTransaction`.
- `tx.wait()` blocks until the transaction is mined (1 confirmation
  on a local Hardhat node, near-instant; on a real testnet it
  could be several seconds).

### 4.5 Smart contract — `castVote` (Solidity)

```solidity
function castVote(
    uint256 electionId,
    bytes32 voterCommitmentHash,
    bytes32 voteHash
) external {
    if (voterCommitmentHash == bytes32(0)) revert EmptyVoterCommitment();
    if (voteHash == bytes32(0))            revert EmptyVoteHash();

    Election storage e = _getExisting(electionId);
    ElectionStatus status = _statusOf(e);
    if (status != ElectionStatus.Active) revert ElectionNotActive(electionId, status);

    if (_hasVoted[electionId][voterCommitmentHash])
        revert AlreadyVoted(electionId, voterCommitmentHash);

    _hasVoted[electionId][voterCommitmentHash] = true;
    unchecked { e.totalVotes = e.totalVotes + 1; }

    emit VoteCast(electionId, voterCommitmentHash, voteHash, uint64(block.timestamp));
}
```

The on-chain checks are the **source of truth**:

- `electionId` must exist (`Election.exists`).
- Status must be `Active` (computed from `block.timestamp` vs
  `startTime`/`endTime`, with `manuallyClosed` overriding to
  `Closed`).
- The pair `(electionId, voterCommitmentHash)` must not already be
  in `_hasVoted`.
- Both hashes must be non-zero.

If any of these fail, the transaction reverts with a **custom error**
(gas-cheap and structured). `ethers.js` parses the revert data and
the backend re-throws it. The Redis lock is still released by the
`finally` block, so the user can retry once the situation changes.

### 4.6 Frontend confirmation

The 201 response is decoded by `lib/api.js`, the toast says *"Vote
recorded on-chain"*, and the page re-renders showing the
`<VoteReceipt>` panel with the truncated hashes. From the user's point
of view, all of the above happened in well under a second on a local
Hardhat node.

---

## 5. Why three layers of "did this user already vote?"

The service performs the duplicate check **three times** on purpose:

| # | Layer    | Mechanism                                       | Purpose                                    |
| - | -------- | ----------------------------------------------- | ------------------------------------------ |
| 1 | Redis lock | `SET lock:vote:{e}:{u} 1 NX EX 30`             | Block concurrent in-flight votes           |
| 2 | Redis cache | `GET vote:{e}:{u}`                             | Fast happy path, avoids paying gas         |
| 3 | Chain    | `hasUserVoted(electionId, commitment)`          | Authoritative; survives Redis wipe         |

The contract itself adds a 4th, atomic check inside `castVote`. So
even if the backend's pre-flight passes, the chain still rejects the
duplicate atomically. The pre-flight is purely about UX (failing fast
without paying gas) and about defending the off-chain state from
tampering.

---

## 6. Privacy and integrity properties (recap)

- **Vote contents are private**. The chain only sees `voteHash`. To
  recover the option, you need both `nonce` and `electionId|option`
  layout — both kept by the backend.
- **Voter identity is private**. The chain only sees
  `voterCommitmentHash`. Without the salt and the user table, you
  cannot map a commitment to a user.
- **One vote per user per election** is guaranteed atomically by the
  contract.
- **Audit trail is public**. Anyone can:
  - count `VoteCast` events per election to verify turnout,
  - call `getElection(id)` to read `totalVotes`, `metadataHash`,
    `startTime`, `endTime`, `status`,
  - spot mismatches if the backend's published metadata file
    re-hashes to something different from the on-chain
    `metadataHash`.
- **Tally is reproducible**. If the platform ever needs to prove
  results (audit / dispute), it can publish, per vote, `(option,
  nonce)`. Each `voteHash` then verifiably matches its option, and
  the relative count of options can be checked against the on-chain
  `totalVotes`.

---

## 7. Failure modes and what the user sees

| Failure                                  | Where detected                | HTTP / UX                                  |
| ---------------------------------------- | ----------------------------- | ------------------------------------------ |
| User not authenticated                   | `preHandler`                  | `401`, redirect to `/login`                |
| Wrong role                               | route                         | `403`                                      |
| `selectedOption` out of range (Zod)      | `castVoteSchema.parse`        | `400 VALIDATION_ERROR` toast              |
| Election not found                       | service                       | `404 ELECTION_NOT_FOUND`                   |
| Two HTTP calls in flight for same user   | Redis `NX` lock               | `409 VOTE_IN_PROGRESS`                     |
| Already voted (Redis says so)            | service                       | `409 ALREADY_VOTED`                        |
| Already voted (chain says so)            | service pre-flight            | `409 ALREADY_VOTED`                        |
| Election not active (off-chain)          | service pre-flight            | `409 ELECTION_NOT_ACTIVE`                  |
| Election not active (on-chain race)      | contract `ElectionNotActive`  | `500` toast, lock released                 |
| Already voted race (on-chain)            | contract `AlreadyVoted`       | `500` toast, lock released                 |
| Rate limit hit                           | `@fastify/rate-limit`         | `429 Too Many Requests`                    |
| Chain unreachable                        | service / receipt wait        | `500` toast, vote NOT recorded             |

The Redis lock has a **30 s TTL** so a backend crash mid-flight cannot
permanently brick the user — the lock auto-expires.

---

## 8. What an attacker can and cannot do

| Attack                                          | Mitigation                                            |
| ----------------------------------------------- | ----------------------------------------------------- |
| Steal another user's vote                       | Login requires email + bcrypt password; JWT is per-user |
| Vote twice with the same account                | Triple check + atomic on-chain mapping                |
| Vote twice by creating two accounts             | Application-level: outside the contract's scope. Mitigated by whatever the registration policy is (e.g. KYC, invite list — not implemented in this MVP) |
| Forge a vote without the user                   | Requires the relayer's private key                   |
| Replay an old `voteHash`                        | The contract rejects: a new commitment is needed; an old commitment+vote is already in `_hasVoted` |
| Brute-force the option from the `voteHash`      | 32-byte random nonce makes pre-image search infeasible |
| Re-identify a voter from the commitment          | Requires `VOTER_HASH_SALT`, which is a server secret |
| Tamper with the off-chain metadata              | `metadataHash` re-check surfaces it as `metadata mismatch` |
| Censor a vote (relayer refuses to broadcast)    | **NOT mitigated**: this is the trust assumption of the relayer model. Visible on-chain because the user can show their off-chain receipt vs the absence of a `VoteCast` event |

---

## 9. Where each piece lives in the repo

| Concept                           | File                                              |
| --------------------------------- | ------------------------------------------------- |
| Frontend vote button              | `frontend/components/voting/VoteForm.jsx`         |
| Frontend API client               | `frontend/lib/api.js` (`api.vote`)                |
| HTTP route                        | `backend/src/routes/votes.routes.js`              |
| Body schema                       | `backend/src/schemas/vote.schemas.js`             |
| Vote orchestration                | `backend/src/services/vote.service.js`            |
| Redis layout for votes + lock     | `backend/src/repositories/vote.repository.js`     |
| Hash helpers                      | `backend/src/utils/hash.js`                       |
| Relayer wallet + ethers contract  | `backend/src/plugins/blockchain.js`               |
| Solidity contract                 | `contracts/contracts/VotingRegistry.sol`          |
| Contract ABI used by the backend  | `backend/src/abi/VotingRegistry.json`             |
| Deployment manifest               | `contracts/deployments/<network>.json`            |

---

## 10. One-line summary

**The user authenticates against the backend and selects an option.
The backend deterministically derives a per-user commitment, mixes
the option with a fresh random nonce to obtain an opaque vote hash,
signs a `castVote` transaction with the single relayer key, and
persists the resulting receipt. The chain enforces atomically that
the election is active and that this commitment has not voted before;
nothing about the user's identity or the actual choice ever reaches
the chain in the clear.**
