# Secure Online Voting Platform — Project Presentation

A concise overview of the project, its stack, the backend API surface,
the voting mechanism, the local development setup, and the planned AWS
architecture.

---

## 1. Project description

The platform lets users **register with an email and a password**, log
in, and **cast a single vote** in any election currently open. Election
lifecycle (creation, early opening, manual closing) is reserved to an
**admin** account that is bootstrapped from environment variables on
backend startup — no admin can be created from the UI.

The defining design choice is that **votes are anchored on a
blockchain**, but voters never interact with it directly:

- Users authenticate against a normal web backend; they do **not** have
  a wallet, do **not** sign transactions, and do **not** pay gas.
- A single server-side **relayer** (one private key, one address) is
  the only entity that talks to the chain. It signs all administrative
  actions and all `castVote` transactions.
- The chain stores **only opaque `bytes32` hashes**. It can prove that
  a vote was cast, that exactly one vote was recorded per voter, and
  that the election text has not been tampered with — without ever
  learning who voted or what they voted for.

The result is a UX that feels like any other web app, with an
**auditable and tamper-evident on-chain trail** sitting underneath.

The repository is split into three independent modules:

| Folder       | Role                                       |
| ------------ | ------------------------------------------ |
| `contracts/` | Solidity smart contract (`VotingRegistry`) |
| `backend/`   | Fastify API + Redis + relayer wallet       |
| `frontend/`  | Next.js 14 web UI                          |

```
[Hardhat node :8545]  ◄── signed tx ──  [Backend Fastify :3001]  ◄── HTTP + JWT ──  [Frontend Next.js :3000]
                                                │
                                                └── [Redis :6379]
```

---

## 2. Stack and technologies

### Smart contracts (`contracts/`)

- **Solidity** with **Hardhat** as the development environment.
- **OpenZeppelin Contracts** for the `Ownable` access-control pattern.
- **ethers.js v6** for tests and deploy scripts.
- The contract `VotingRegistry` exposes `createElection`,
  `openElection`, `closeElection`, `castVote`, plus the read-only
  `getElection`, `getStatus`, `hasUserVoted`.

### Backend (`backend/`)

- **Node.js ≥ 20** (ESM).
- **Fastify 4** as the HTTP framework, with the official plugins
  `@fastify/cors`, `@fastify/helmet`, `@fastify/jwt`,
  `@fastify/rate-limit`.
- **Redis 7** (via `ioredis`) as the only persistent store for
  off-chain data: users, election metadata, vote receipts, locks,
  rate-limit counters.
- **bcryptjs** for password hashing, **ulid** for user IDs, **Zod**
  for request/response validation, **Pino** for structured logging.
- **ethers.js v6** for the relayer wallet and contract bindings.

### Frontend (`frontend/`)

- **Next.js 14** with the **App Router** and **React 18**.
- **TailwindCSS** for styling, **react-hook-form + Zod** for forms,
  **react-hot-toast** for feedback.
- A thin client (`lib/api.js`) wraps the backend API and attaches the
  JWT (stored in `localStorage`) to every authenticated call.

### Infrastructure (local)

- **Hardhat node** as a local EVM (chainId `31337`).
- **Redis 7** in a Docker container.
- All wired together by environment files (`.env`).

---

## 3. Backend endpoints

Base URL: `http://localhost:3001`. Authenticated routes require an
`Authorization: Bearer <jwt>` header. JSON in / JSON out. Errors share
the shape `{ error, message, details? }`.

| Method | Path                                | Role            | Purpose                                                      |
| ------ | ----------------------------------- | --------------- | ------------------------------------------------------------ |
| GET    | `/health`                           | public          | Liveness probe                                               |
| POST   | `/auth/register`                    | public          | Voter self-registration (email + password)                   |
| POST   | `/auth/login`                       | public *(rate-limited)* | Issues a JWT for voter or admin                      |
| GET    | `/auth/me`                          | authenticated   | Returns the current user                                     |
| GET    | `/elections`                        | public          | List all elections (off-chain mirror)                        |
| GET    | `/elections/:id`                    | public          | Read a single election                                       |
| GET    | `/elections/:id/status`             | public          | Live election status read **from chain**                     |
| POST   | `/admin/elections`                  | admin           | Create an election on-chain + mirror metadata in Redis       |
| POST   | `/admin/elections/:id/open`         | admin           | Open an election early (`openElection`)                      |
| POST   | `/admin/elections/:id/close`        | admin           | Manually close an active election (`closeElection`)          |
| GET    | `/admin/elections`                  | admin           | Admin view of the elections list                             |
| POST   | `/elections/:id/vote`               | voter / admin *(rate-limited)* | Cast a vote (relayed on-chain)                |
| GET    | `/elections/:id/my-vote-status`     | authenticated   | Whether the current user has already voted                   |

Cross-cutting safeguards:

- **JWT** signed with a 32+ char secret; auto-logout on `401`.
- **Per-user rate limits** on login and on vote casting.
- **Zod schema validation** on every request body / params.
- **Redis lock** (`SET … NX EX 30`) per `(election, user)` to block
  parallel vote attempts.

---

## 4. How the voting system works

The voting flow is the heart of the project. It combines a
meta-transaction pattern (the relayer signs on behalf of users) with
three deterministic hashes that keep voter identity and vote contents
**private**, while still allowing **public verification** of turnout
and integrity.

### The three hashes

| Hash                   | Formula                                              | Purpose                                                                 |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `metadataHash`         | `keccak256(canonicalJSON(election))`                 | Tamper-evidence for election text (title, options, window, …)           |
| `voterCommitmentHash`  | `keccak256(userId \| electionId \| salt)`            | Deterministic per-user fingerprint; enforces *one vote per user*        |
| `voteHash`             | `keccak256(electionId \| option \| nonce32B)`        | Hides the chosen option behind a fresh 32-byte random nonce             |

- The `salt` is a server secret (`VOTER_HASH_SALT`, ≥ 32 chars), never
  logged and never returned by any API.
- The per-vote `nonce` is generated server-side and stored only in
  Redis. Without it, a 32-byte hash of a 2-option ballot would be
  brute-forceable.

### Step-by-step (clicking "Confirm vote")

1. The frontend sends `POST /elections/:id/vote { selectedOption }`
   with the user's JWT. It does **not** know the salt, the nonce, the
   relayer key, or the contract address.
2. The backend validates the JWT and the role, and validates the body
   against the Zod schema.
3. It acquires a Redis lock `lock:vote:{election}:{user}` with `NX EX
   30` — concurrent calls return `409 VOTE_IN_PROGRESS`.
4. **Off-chain** double-vote check: if a receipt already exists in
   Redis → `409 ALREADY_VOTED`.
5. It computes the deterministic `voterCommitmentHash` and runs an
   **on-chain** double-vote check via `hasUserVoted(...)` (this guards
   against a wiped Redis).
6. It reads `getStatus(...)` to confirm the election is `Active`.
7. It generates `nonce = randomBytes(32)` and computes `voteHash`.
8. It signs and broadcasts `castVote(electionId, voterCommitmentHash,
   voteHash)` with the relayer wallet, then waits for the receipt.
9. The contract atomically: checks `Active` status, rejects duplicate
   `(electionId, voterCommitmentHash)`, sets `_hasVoted = true`,
   increments `totalVotes`, emits `VoteCast(...)`.
10. The backend persists the full receipt in Redis under
    `vote:{electionId}:{userId}` (including option and nonce, which
    are **never** returned to the client) and releases the lock.
11. The API responds `201` with a redacted view: `txHash`,
    `blockNumber`, `voteHash`, `voterCommitmentHash`, `castAt`. The UI
    renders the **vote receipt** card.

### Why three layers of duplicate-vote checks

| # | Layer            | Mechanism                                | Purpose                                |
| - | ---------------- | ---------------------------------------- | -------------------------------------- |
| 1 | Redis NX-EX lock | `SET lock:vote:{e}:{u} 1 NX EX 30`       | Block concurrent in-flight votes       |
| 2 | Redis cache      | `GET vote:{e}:{u}`                       | Fast happy path, avoid paying gas      |
| 3 | On-chain pre-flight | `hasUserVoted(e, commitment)`         | Authoritative; survives Redis wipe     |
| 4 | Contract atomic check | `_hasVoted[e][cmt]` inside `castVote` | Final source of truth                  |

### Privacy and integrity properties

- **Vote contents are private**: the chain only sees `voteHash`;
  recovering the option requires the secret nonce.
- **Voter identity is private**: the chain only sees
  `voterCommitmentHash`; without `VOTER_HASH_SALT` it cannot be linked
  back to a user.
- **One vote per user per election** is guaranteed atomically by the
  contract.
- **Tally is reproducible**: the platform can publish, for each vote,
  `(option, nonce)` and any third party can verify both `voteHash`
  and the per-option counts against `totalVotes`.

The trade-off is that the **relayer is trusted not to censor votes**.
It cannot forge or alter them — but a malicious relayer could refuse
to broadcast a vote. This is the standard meta-transaction trust
model.

---

## 5. Local development setup

The full stack runs on a developer laptop with **5 parallel terminals**
(Windows / PowerShell instructions, Linux/macOS is analogous).

### Prerequisites

- **Node.js ≥ 20** (tested on 22.x), **npm ≥ 10**
- **Docker Desktop** (for Redis)
- **Git** + a shell

### One-time install

```powershell
cd contracts; npm install; cd ..
cd backend;   npm install; cd ..
cd frontend;  npm install; cd ..
```

### Run order

| # | Terminal          | Command                                                                   | Notes                                              |
| - | ----------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| 1 | Hardhat node      | `cd contracts; npx hardhat node`                                          | EVM at `http://127.0.0.1:8545`, chainId `31337`    |
| 2 | Contract deploy   | `cd contracts; npm run deploy:local`                                      | Deploys `VotingRegistry`; writes `deployments/localhost.json` |
| 3 | Redis             | `docker run --rm --name voting-redis -p 6379:6379 redis:7-alpine`         | Ephemeral by design (no persistence)               |
| 4 | Backend           | `cd backend; Copy-Item .env.example .env; npm run dev`                    | Fastify on `:3001`; bootstraps the admin user      |
| 5 | Frontend          | `cd frontend; Copy-Item .env.example .env.local; npm run dev`             | Next.js on `:3000`                                 |

### Environment configuration

`backend/.env` (copy from `.env.example`, only secrets must be
replaced):

```dotenv
PORT=3001
HOST=0.0.0.0
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000

REDIS_URL=redis://127.0.0.1:6379

JWT_SECRET=<random string ≥ 32 chars>
JWT_EXPIRES_IN=2h

ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ChangeMeNow!123

RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337
PRIVATE_KEY=0xac09...ff80   # Hardhat signer #0 (default)
CONTRACT_ADDRESS=0x5FbDB231...0aa3   # output of deploy:local

VOTER_HASH_SALT=<another random string ≥ 32 chars>
```

`frontend/.env.local`:

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:3001
```

### Smoke test

1. Open <http://localhost:3000>, log in as admin
   (`admin@example.com` / `ChangeMeNow!123`).
2. From `/admin/elections/new` create an election with ≥ 2 options.
3. Click **Open now** to activate it on-chain.
4. In a private window, register a voter, open the election from
   `/dashboard`, cast a vote and verify the receipt.
5. Reload the page — the form is gone and the receipt is still there.
6. As admin, click **Close** to end the election.

### Critical constraint

The backend `PRIVATE_KEY` **must equal the contract `owner`** (set at
deploy time). The default Hardhat signer #0 satisfies this out of the
box. If the Hardhat node is restarted, the contract has to be
redeployed and the new `CONTRACT_ADDRESS` copied into `backend/.env`.

---

## 6. AWS architecture (without deploy details)

The deployment target on AWS preserves the same three-tier separation
of the local setup, mapping each component to a managed service that
minimizes operational overhead.

### Service mapping

| Local component                   | AWS service                          | Why                                                                            |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| Frontend (Next.js 14 SSR)         | **Amplify Hosting**                  | Native SSR support, CDN (CloudFront) + free TLS + GitHub-driven CI out of the box |
| Backend (Fastify relayer)         | **ECS Express Mode** (+ **ECR**)     | Long-running stateful container, managed ALB with HTTPS, auto ACM cert, env-var injection — successor of App Runner |
| Hardhat node + Redis              | **Lightsail VM** (1 GB)              | Self-hosted EVM (full control, identical to local) and Redis in one cheap box  |

### Architecture diagram

```
                              ┌─────────────────────────────────────────────┐
                              │                  AWS                        │
   Browser                    │                                             │
       │                      │   ┌──────────────────────────┐              │
       │  HTTPS               │   │  Amplify Hosting         │              │
       ├─────────────────────►│   │  Next.js 14 (SSR)        │              │
       │                      │   │  *.amplifyapp.com        │              │
       │                      │   └────────────┬─────────────┘              │
       │                      │                │                            │
       │                      │                ▼                            │
       │  HTTPS               │   ┌──────────────────────────────────┐      │
       │  (direct API calls)  │   │  ECS Express Mode                │      │
       ├─────────────────────►│   │  ALB (HTTPS, ACM)                │      │
       │                      │   │   └─► Fargate task               │      │
       │                      │   │        Fastify relayer           │      │
       │                      │   └───────────────┬──────────────────┘      │
       │                      │                   │ JSON-RPC + Redis        │
       │                      │                   ▼                         │
       │                      │   ┌──────────────────────────────────┐      │
       │                      │   │  Lightsail VM (1 GB)             │      │
       │                      │   │   ├─ Hardhat node :8545          │      │
       │                      │   │   └─ Redis :6379 (auth+AOF)      │      │
       │                      │   └──────────────────────────────────┘      │
       └──────────────────────└─────────────────────────────────────────────┘
```

### Design choices

- **No custom VPC, no Route 53 custom domain, no Secrets Manager.**
  ECS Express Mode auto-provisions VPC, subnets, ALB, ACM certificate,
  log group, and an AWS-provided `*.<region>.on.aws` hostname.
- **No ElastiCache.** Redis runs on the Lightsail VM with
  `requirepass` and `appendonly yes`. The expected throughput
  (per-user rate-limited votes) is well within a single 1 GB node.
- **No external RPC provider.** The Hardhat node lives on the same
  Lightsail VM as Redis — the on-chain experience is identical to the
  local setup, with no Alchemy / Infura free-tier dependency.
- **Container registry**: the backend image is built locally (or by
  CI) and pushed to **Amazon ECR**, which is the registry consumed by
  ECS Express Mode.
- **Secrets**: the relayer `PRIVATE_KEY` in this setup is the well
  known Hardhat signer #0 — public knowledge, zero economic value, no
  real gas. `JWT_SECRET` and `VOTER_HASH_SALT` are stored in the ECS
  Express service config (encrypted at rest), which is enough for a
  demo without standing up a full Secrets Manager pipeline.

The AWS layout is intentionally **kept minimal**: each box on the
diagram has a clear responsibility, and every component that exists
locally maps to exactly one AWS service.
