# Voting Platform — Backend

Fastify + Redis backend for the secure online voting platform. Acts as a
**relayer** in front of the `VotingRegistry` smart contract: end users do
not own a wallet, they authenticate against the API and the backend signs
all on-chain transactions (admin lifecycle and `castVote`) with a single
relayer key that must coincide with the contract `owner`.

> Phase 1 (smart contracts) lives in [`../contracts`](../contracts).
> Phase 3 (frontend) is not part of this folder.

## Stack

- Node.js ≥ 20, ESM (`"type": "module"`), **plain JavaScript** (no TS).
- [Fastify 4](https://fastify.dev/) + `@fastify/jwt`, `@fastify/cors`,
  `@fastify/helmet`, `@fastify/rate-limit`.
- Redis via [`ioredis`](https://github.com/redis/ioredis) — sole storage.
- [`ethers` v6](https://docs.ethers.org/v6/) for chain access.
- [`zod`](https://zod.dev/) for input validation.
- [`bcryptjs`](https://github.com/dcodeIO/bcrypt.js) for password hashing
  (pure JS, no native build — friendlier on Windows than `argon2`).
- `pino` for logging (with redaction of secrets).
- `vitest` + [`ioredis-mock`](https://github.com/stipsan/ioredis-mock) for
  tests; the chain is mocked in-memory, so **no Hardhat node is required**
  to run the test suite.

## Project layout

```
backend/
  src/
    app.js                       # buildApp(opts) — wires everything
    server.js                    # entrypoint: seed admin, listen, graceful shutdown
    abi/VotingRegistry.json
    config/index.js              # zod-validated env loader
    plugins/
      redis.js                   # decorates app.redis (ioredis)
      auth.js                    # @fastify/jwt + app.authenticate / app.requireAdmin
      blockchain.js              # decorates app.chain (relayer wallet + helpers)
      errorHandler.js            # central JSON error handler (Zod, HttpError, JWT, 5xx)
    routes/
      auth.routes.js
      admin.routes.js
      elections.routes.js
      votes.routes.js
    services/
      auth.service.js
      election.service.js
      vote.service.js
    repositories/
      user.repository.js
      election.repository.js
      vote.repository.js
    schemas/                     # zod request schemas
    utils/
      hash.js                    # keccak256 helpers (metadata, voter commitment, vote)
      ids.js                     # ULID-based user ids
      errors.js                  # HttpError + helpers (badRequest, unauthorized, ...)
  test/
    auth.test.js
    elections.test.js
    votes.test.js
    helpers/
      buildTestApp.js            # in-memory app (RedisMock + chain mock)
      mockChain.js               # behavior-faithful VotingRegistry mock
  .env.example
  package.json
  vitest.config.js
  API.md                         # endpoint reference with request/response samples
```

## Redis key layout

| Key                                  | Type   | Content                                                                              |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------ |
| `user:{userId}`                      | hash   | `{id, email, passwordHash, role, createdAt}`                                         |
| `user_email:{email}`                 | string | `userId` — secondary index, enforces email uniqueness                                |
| `election:{electionId}`              | string | JSON: `{id, title, description, options, startTime, endTime, metadataHash, ...}`     |
| `election:list`                      | set    | All known `electionId`s                                                              |
| `vote:{electionId}:{userId}`         | string | JSON: `{voteHash, voterCommitmentHash, selectedOption, nonce, txHash, blockNumber}`  |
| `lock:vote:{electionId}:{userId}`    | string | Short-lived advisory lock (TTL 30s) preventing concurrent votes for the same user   |
| `rl:*`                               | misc   | Used by `@fastify/rate-limit` (login + vote limiters)                                |

## Security model

- **Passwords** are hashed with bcryptjs (cost 10).
- **JWT** is stateless. Token payload: `{sub: userId, email, role}`. TTL
  configurable via `JWT_EXPIRES_IN`.
- **Roles:** `admin` (created at boot from `ADMIN_EMAIL`/`ADMIN_PASSWORD`,
  idempotent) and `voter` (default for public registration).
- **Anti-double-vote:** triple-layered.
  1. `SET lock:vote:{electionId}:{userId} NX EX 30` before doing anything,
     released in a `finally`.
  2. Off-chain check on `vote:{electionId}:{userId}`.
  3. On-chain check via `VotingRegistry.hasUserVoted(electionId, voterCommitmentHash)`
     — even if Redis state is wiped, the contract is the source of truth.
- **Privacy on-chain:** the contract only ever sees opaque `bytes32`
  hashes. Personal data and the voter→ballot mapping live exclusively in
  the backend.
- **`voterCommitmentHash` = `keccak256("{userId}|{electionId}|{salt}")`**
  with a server-secret salt (`VOTER_HASH_SALT`). Deterministic so the
  backend can recompute it for `hasUserVoted` lookups.
- **`voteHash` = `keccak256("{electionId}|{selectedOption}|{nonce}")`**
  with a fresh 32-byte random nonce stored alongside the vote in Redis.
  This makes the on-chain hash unpredictable even when the option set is
  small, while remaining verifiable later.
- **Rate limits** on login and vote (per-IP+email and per-user
  respectively), backed by the same Redis instance.
- **CORS** restricted to a configurable origin list.
- **Helmet** sets sensible HTTP security headers.
- **Logging** uses pino with redaction of `authorization`, `cookie`,
  `req.body.password` and `req.body.passwordHash`.
- **No private key in code:** `PRIVATE_KEY` only via `.env`. Same for
  `JWT_SECRET` and `VOTER_HASH_SALT`.

## Setup

1. **Smart contract first.** Deploy the contract as documented in
   [`../contracts/README.md`](../contracts/README.md) and copy the
   resulting `address` (e.g. from `contracts/deployments/<network>.json`).
2. **Install deps.**

   ```bash
   cd backend
   npm install
   ```

3. **Configure environment.** Copy `.env.example` to `.env` and fill in:
   - `JWT_SECRET` and `VOTER_HASH_SALT` — long random strings (≥ 32 chars).
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` — bootstrap admin (created on first run).
   - `RPC_URL`, `CHAIN_ID`, `PRIVATE_KEY` — relayer (must match the
     contract `owner` to perform admin operations and to call `castVote`).
   - `CONTRACT_ADDRESS` — `VotingRegistry` address from step 1.
   - `REDIS_URL` — defaults to `redis://127.0.0.1:6379`.

4. **Run Redis** locally (e.g. via Docker):

   ```bash
   docker run --rm -p 6379:6379 redis:7-alpine
   ```

5. **Start the API**:

   ```bash
   npm run dev    # node --watch
   # or
   npm start
   ```

   You should see logs like:

   ```
   {"level":"info","msg":"Admin user is ready","email":"admin@example.com"}
   {"level":"info","msg":"Server listening at http://0.0.0.0:3001"}
   ```

## Tests

```bash
npm test
```

The test suite uses `ioredis-mock` and an in-memory chain client, so it
runs without Redis or Hardhat. Coverage:

- **auth.test.js** — register, duplicate email, validation errors, login,
  invalid credentials, `/auth/me` with and without token, admin seed.
- **elections.test.js** — admin creates election, non-admin blocked,
  unauthenticated blocked, validation (too few options, bad time window),
  public list/read/status, open + close lifecycle, 404 on unknown.
- **votes.test.js** — happy path, double-vote prevention via Redis,
  double-vote prevention even after wiping Redis (on-chain re-check),
  invalid option (semantic + zod), voting on closed election rejected,
  unauthenticated rejected, `my-vote-status` before/after voting.

22 tests, all green.

## API reference

See [`API.md`](./API.md) for the full endpoint reference with example
request/response payloads.

## Operational notes

- The backend assumes the relayer (`PRIVATE_KEY`) is the contract owner
  — required by `createElection`/`openElection`/`closeElection`. If you
  need separation of duties (admin key vs. voter-relayer key), the
  blockchain plugin is the only place that needs to change.
- `electionService.getStatus` reads on-chain truth (`getElection`) and
  also reports whether the on-chain `metadataHash` still matches the
  off-chain document (`metadataMatches`) — useful for tamper detection.
- Graceful shutdown closes Fastify (which closes Redis) on `SIGINT` /
  `SIGTERM`.
