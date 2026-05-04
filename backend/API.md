# API reference

Base URL: `http://localhost:3001` (configurable via `PORT`/`HOST`).

All request/response bodies are JSON. Authenticated endpoints expect a
`Authorization: Bearer <jwt>` header. Errors are always returned with
the following shape:

```json
{ "error": "MACHINE_CODE", "message": "Human readable", "details": {...} }
```

For input-validation failures, `error` is `VALIDATION_ERROR` and
`issues` is an array of `{ path, message, code }`.

## Conventions

- Times are **unix seconds**.
- Election ids are stringified `uint256` as returned by the smart
  contract (`"0"`, `"1"`, ...).
- Hashes are `0x`-prefixed lowercase hex.
- Status values: `created` | `active` | `closed`.

---

## Health

### `GET /health`

```json
{ "status": "ok", "uptime": 123.456 }
```

---

## Auth

### `POST /auth/register`

Register a new voter. Email is normalized to lowercase. Public.

Request:

```json
{ "email": "alice@example.com", "password": "Strong!Pass123" }
```

Response `201`:

```json
{
  "user": {
    "id": "usr_01HXYZ...",
    "email": "alice@example.com",
    "role": "voter",
    "createdAt": "2026-04-30T17:50:00.000Z"
  }
}
```

Errors: `409 EMAIL_TAKEN`, `400 VALIDATION_ERROR`.

---

### `POST /auth/login`

Public, **rate-limited** (`RATE_LIMIT_LOGIN_*`, default 5/min per
`ip+email`).

Request:

```json
{ "email": "alice@example.com", "password": "Strong!Pass123" }
```

Response `200`:

```json
{
  "token": "eyJhbGciOi...",
  "user": { "id": "usr_...", "email": "alice@example.com", "role": "voter", "createdAt": "..." }
}
```

Errors: `401 INVALID_CREDENTIALS`, `429 RATE_LIMITED`.

---

### `GET /auth/me`

Authenticated. Returns the current user.

Response `200`:

```json
{ "user": { "id": "usr_...", "email": "...", "role": "voter", "createdAt": "..." } }
```

Errors: `401 UNAUTHORIZED`.

---

## Public elections

### `GET /elections`

Public list. Response `200`:

```json
{
  "elections": [
    {
      "id": "0",
      "title": "Best pizza topping",
      "description": "Choose wisely",
      "options": ["Margherita", "Diavola", "Quattro Formaggi"],
      "startTime": 1735000000,
      "endTime": 1735003600,
      "metadataHash": "0xabc...def",
      "manuallyClosed": false,
      "createdAt": "2026-04-30T17:50:00.000Z",
      "txHash": "0x...",
      "status": "active"
    }
  ]
}
```

### `GET /elections/:id`

Public single read. Response `200`: `{ "election": { ... } }`.
Errors: `404 ELECTION_NOT_FOUND`.

### `GET /elections/:id/status`

Public live status, **read from chain**. Response `200`:

```json
{
  "status": {
    "id": "0",
    "status": "active",
    "totalVotes": 17,
    "startTime": 1735000000,
    "endTime": 1735003600,
    "metadataHash": "0xabc...def",
    "metadataMatches": true
  }
}
```

If the RPC is unreachable the response falls back to the locally
derived status and includes a `chainError` field.

---

## Admin (role: `admin`)

All endpoints below require `Authorization: Bearer <adminJwt>` and
`role: "admin"` (otherwise `403 FORBIDDEN`).

### `POST /admin/elections`

Creates an election on-chain (with off-chain metadata mirrored in Redis).

Request:

```json
{
  "title": "Best pizza topping",
  "description": "Choose wisely",
  "options": ["Margherita", "Diavola", "Quattro Formaggi"],
  "startTime": 1735000000,
  "endTime": 1735003600
}
```

Response `201`:

```json
{
  "election": {
    "id": "0",
    "title": "Best pizza topping",
    "description": "Choose wisely",
    "options": ["Margherita", "Diavola", "Quattro Formaggi"],
    "startTime": 1735000000,
    "endTime": 1735003600,
    "metadataHash": "0xabc...def",
    "manuallyClosed": false,
    "createdBy": { "id": "usr_...", "email": "admin@example.com" },
    "createdAt": "2026-04-30T17:50:00.000Z",
    "txHash": "0x...",
    "blockNumber": 42
  }
}
```

Errors: `400 VALIDATION_ERROR`, `400 INVALID_TIME_WINDOW`,
`401 UNAUTHORIZED`, `403 FORBIDDEN`.

### `POST /admin/elections/:id/open`

Opens an election early (moves `startTime` to "now"). The election must
exist, must not have started yet, must not be manually closed.

Response `200`: `{ "election": { ... } }`.
Errors: `404 ELECTION_NOT_FOUND`, `409 ELECTION_ALREADY_STARTED`.

### `POST /admin/elections/:id/close`

Manually closes an election. After this call the contract reports
`Closed` regardless of `endTime`.

Response `200`: `{ "election": { ... } }`.
Errors: `404 ELECTION_NOT_FOUND`, `409 ELECTION_ALREADY_CLOSED`.

### `GET /admin/elections`

Same payload as the public list, intended for the admin dashboard.

---

## Voting (role: `voter` or `admin`)

### `POST /elections/:id/vote`

Authenticated. **Rate-limited** (`RATE_LIMIT_VOTE_*`, default 3/min per
user). Cast a vote for an active election.

Request:

```json
{ "selectedOption": 1 }
```

Process:

1. Verify JWT and role (`voter` or `admin`).
2. Verify election exists.
3. Acquire Redis lock `lock:vote:{electionId}:{userId}` (NX, TTL 30s).
4. Off-chain double-vote check (`vote:{electionId}:{userId}`).
5. Recompute `voterCommitmentHash` and on-chain double-vote check
   (`hasUserVoted`).
6. Check election is `Active` on-chain.
7. Generate random 32-byte nonce, compute `voteHash`.
8. Send `castVote(electionId, voterCommitmentHash, voteHash)` to the
   contract.
9. Persist `{ voteHash, voterCommitmentHash, selectedOption, nonce,
   txHash, blockNumber, castAt }` in Redis.
10. Release the lock.

Response `201`:

```json
{
  "vote": {
    "electionId": "0",
    "txHash": "0x...",
    "blockNumber": 43,
    "voteHash": "0xabc...",
    "voterCommitmentHash": "0xdef...",
    "castAt": "2026-04-30T17:55:00.000Z"
  }
}
```

Errors:

- `400 VALIDATION_ERROR` (zod) or `400 INVALID_OPTION` (semantic).
- `401 UNAUTHORIZED`.
- `403 FORBIDDEN` (role not allowed).
- `404 ELECTION_NOT_FOUND`.
- `409 VOTE_IN_PROGRESS` (lock already held).
- `409 ALREADY_VOTED` (off-chain or on-chain check).
- `409 ELECTION_NOT_ACTIVE`.
- `429 RATE_LIMITED`.

### `GET /elections/:id/my-vote-status`

Authenticated. Returns whether the current user has voted, sourced
from Redis if present and falling back to the on-chain
`hasUserVoted`.

Response `200` (already voted):

```json
{
  "status": {
    "electionId": "0",
    "hasVoted": true,
    "source": "off-chain",
    "txHash": "0x...",
    "voteHash": "0x...",
    "castAt": "2026-04-30T17:55:00.000Z"
  }
}
```

Response `200` (not voted yet):

```json
{ "status": { "electionId": "0", "hasVoted": false, "source": "on-chain" } }
```

---

## Curl quick-start

```bash
# 1) Login as admin
TOKEN=$(curl -s -X POST http://localhost:3001/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"ChangeMeNow!123"}' | jq -r .token)

# 2) Create an election (start in 1 minute, lasts 1 hour)
NOW=$(date +%s); START=$((NOW+60)); END=$((NOW+3660))
curl -s -X POST http://localhost:3001/admin/elections \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Pizza\",\"description\":\"\",\"options\":[\"A\",\"B\"],\"startTime\":$START,\"endTime\":$END}"

# 3) Open it now
curl -s -X POST http://localhost:3001/admin/elections/0/open \
  -H "authorization: Bearer $TOKEN"

# 4) Register + login as a voter
curl -s -X POST http://localhost:3001/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"Strong!Pass123"}'
VTOKEN=$(curl -s -X POST http://localhost:3001/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"Strong!Pass123"}' | jq -r .token)

# 5) Vote
curl -s -X POST http://localhost:3001/elections/0/vote \
  -H "authorization: Bearer $VTOKEN" \
  -H 'content-type: application/json' \
  -d '{"selectedOption":1}'
```
