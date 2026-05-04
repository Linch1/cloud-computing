# Voting Platform — Local Testing Guide

End-to-end guide to run the whole stack (smart contracts, backend, frontend)
in a local **testing environment** on Windows / PowerShell.

The repository contains three independent modules:

| Folder        | Stack                                  | Default port |
| ------------- | -------------------------------------- | ------------ |
| `contracts/`  | Solidity + Hardhat (local EVM node)    | `8545`       |
| `backend/`    | Node.js + Fastify + Redis (relayer)    | `3001`       |
| `frontend/`   | Next.js 14 (App Router)                | `3000`       |

Each module has its own detailed README; this document focuses on the
**glue** required to bring them up together.

---

## Architecture

```
[Hardhat node :8545]  ◄── signed tx (relayer) ──  [Backend Fastify :3001]  ◄── HTTP + JWT ──  [Frontend Next.js :3000]
                                                         │
                                                         └── [Redis :6379]
```

- The frontend **never** talks to the chain directly and holds **no
  private key**.
- The backend acts as a **relayer**: it owns a single private key that
  must coincide with the `VotingRegistry` contract `owner`.
- Redis stores users, elections metadata, vote receipts and rate-limit
  counters. The chain stores only opaque `bytes32` hashes.

You will need **5 terminals** running in parallel: 3 for infrastructure
(Hardhat node, contract deploy, Redis) and 2 for the application
services (backend, frontend).

---

## Prerequisites

| Tool             | Tested version |
| ---------------- | -------------- |
| Node.js          | `>= 20` (the repo was tested on 22.x) |
| npm              | `>= 10`        |
| Docker Desktop   | any recent     |
| Git + PowerShell | bundled with Windows |

Verify:

```powershell
node --version
npm --version
docker --version
```

---

## One-time install

From the repository root:

```powershell
cd contracts; npm install; cd ..
cd backend;   npm install; cd ..
cd frontend;  npm install; cd ..
```

---

## 1) Terminal 1 — Hardhat node (local blockchain)

```powershell
cd contracts
npx hardhat node
```

Keep it running. It exposes a JSON-RPC endpoint at
`http://127.0.0.1:8545` with `chainId = 31337` and prints 20
pre-funded test accounts.

The first account (`signer #0`) has the well-known private key

```
0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

which is exactly the `PRIVATE_KEY` already shipped in
`backend/.env.example`. The relayer **must** equal the contract owner,
and by default the deployer becomes the owner — so keeping this default
is what makes everything work out of the box.

---

## 2) Terminal 2 — deploy `VotingRegistry`

```powershell
cd contracts
npm run deploy:local
```

This writes `contracts/deployments/localhost.json` with the deployed
address. On a freshly started Hardhat node the first deployment always
produces:

```
0x5FbDB2315678afecb367f032d93F642f64180aa3
```

…which is also the `CONTRACT_ADDRESS` already present in
`backend/.env.example`. As long as you do not restart the node in
between, **you do not need to change anything**.

If you ever restart the Hardhat node you must redeploy and copy the
new address into `backend/.env` before restarting the backend.

> Optional: run the on-chain test suite first with `npm test`
> (29 cases, fully isolated, no node required).

---

## 3) Terminal 3 — Redis (via Docker)

```powershell
docker run --rm --name voting-redis -p 6379:6379 redis:7-alpine
```

Keep it running. There is **no persistence** in this configuration,
which is exactly what you want for testing: hit `Ctrl+C` to wipe all
off-chain state.

---

## 4) Terminal 4 — Backend (Fastify API)

Create the `.env` from the example:

```powershell
cd backend
Copy-Item .env.example .env
```

Open `backend/.env` and confirm / set the following values. Only the two
**secrets** must be replaced — the rest can stay as-is for local
testing:

```dotenv
PORT=3001
HOST=0.0.0.0
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000

REDIS_URL=redis://127.0.0.1:6379

# Replace with a long random string (>= 32 chars)
JWT_SECRET=replace-me-with-a-long-random-string-32-chars-min
JWT_EXPIRES_IN=2h

ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=ChangeMeNow!123

RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
CONTRACT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3

# Replace with another long random string
VOTER_HASH_SALT=replace-me-with-another-long-random-string
```

Start the API:

```powershell
npm run dev
```

You should see:

```
{"level":"info","msg":"Admin user is ready","email":"admin@example.com"}
{"level":"info","msg":"Server listening at http://0.0.0.0:3001"}
```

Quick smoke test from any other shell:

```powershell
curl http://localhost:3001/elections
```

---

## 5) Terminal 5 — Frontend (Next.js)

```powershell
cd frontend
Copy-Item .env.example .env.local
npm run dev
```

`.env.local` only needs:

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:3001
```

Open the browser at <http://localhost:3000>.

---

## Smoke test — full happy path

1. **Admin login** at <http://localhost:3000/login> using
   `admin@example.com` / `ChangeMeNow!123`. You are redirected to
   `/admin`.
2. Go to `/admin/elections/new` and create an election with at least
   two options and a near-future window (e.g. starts in 1 minute, ends
   in 30 minutes).
3. From the admin elections list, click **Open now** to activate it
   immediately (this calls `openElection` on-chain).
4. **Open a private/incognito window**, register a voter at `/register`,
   land on `/dashboard`, open the election, cast a vote and verify the
   receipt shows the truncated `txHash`, `voteHash` and
   `voterCommitmentHash`.
5. Reload the page: the voting form disappears because the backend now
   sees the existing receipt (in Redis) and confirms it on-chain via
   `hasUserVoted`.
6. As admin, click **Close** to terminate the election: any further
   vote attempt is rejected with `ElectionNotActive`.

---

## Common pitfalls (Windows)

- **Port already in use** (`3000` / `3001` / `6379` / `8545`):

  ```powershell
  netstat -ano | findstr :3001
  taskkill /F /PID <pid>
  ```

- **Docker Desktop not running** → Redis fails to start. Launch Docker
  Desktop before `docker run`.
- **Stale `CONTRACT_ADDRESS`** after restarting the Hardhat node →
  redeploy with `npm run deploy:local`, copy the new address from
  `contracts/deployments/localhost.json` into `backend/.env`, then
  restart the backend.
- **`OwnableUnauthorizedAccount`** when the admin tries to create /
  open / close an election → the backend `PRIVATE_KEY` does not match
  the contract owner. Either keep the Hardhat signer #0 default, or
  set `INITIAL_OWNER` at deploy time to the relayer's address.
- **CORS errors** in the browser → if you change the frontend port,
  update `CORS_ORIGIN` in `backend/.env` accordingly and restart the
  backend.
- **JWT errors / "secret too short"** → `JWT_SECRET` must be at least
  32 characters. Same for `VOTER_HASH_SALT`.

---

## Automated tests (no infra required)

Both contract and backend test suites are fully self-contained and do
not need the Hardhat node or Redis to be running:

```powershell
cd contracts; npm test    # 29 on-chain tests
cd ..\backend; npm test   # 22 API tests (ioredis-mock + chain mock)
```

---

## Shutdown

In each terminal: `Ctrl+C`.
To wipe Redis state explicitly: stop the Redis container (it runs with
`--rm`, so the data volume disappears with it).
To reset on-chain state: stop and restart the Hardhat node, then
redeploy and update `CONTRACT_ADDRESS` in `backend/.env`.

---

## Module-specific documentation

- Smart contracts: [`contracts/README.md`](./contracts/README.md) and
  [`contracts/DOCS.md`](./contracts/DOCS.md)
- Backend API: [`backend/README.md`](./backend/README.md),
  [`backend/API.md`](./backend/API.md), [`backend/DOCS.md`](./backend/DOCS.md)
- Frontend: [`frontend/README.md`](./frontend/README.md)
