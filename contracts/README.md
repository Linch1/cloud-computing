# Voting Registry — Smart Contracts

On-chain layer of the secure online voting platform. The Solidity contract
`VotingRegistry` implements admin-managed elections and tamper-proof,
privacy-preserving vote registration on any EVM-compatible chain.

> Module 1 of 3 — the backend (Node.js + Fastify + Redis) and the frontend
> (Next.js) live in sibling folders and consume the artifacts produced here.

---

## Stack

| Layer        | Tool / Version                  |
| ------------ | ------------------------------- |
| Language     | Solidity `^0.8.20`              |
| Framework    | Hardhat `^2.22` (JavaScript / CommonJS) |
| Libraries    | OpenZeppelin Contracts `^5.0`   |
| Test runner  | Mocha + Chai + Hardhat Toolbox  |
| EVM target   | `paris` (any EVM-compatible L1/L2) |

---

## Project layout

```
contracts/
├── contracts/VotingRegistry.sol   # main contract
├── scripts/deploy.js              # deploy + manifest writer
├── test/VotingRegistry.test.js    # full test suite (29 cases)
├── deployments/<network>.json     # auto-generated post-deploy
├── hardhat.config.js
├── package.json
├── DOCS.md                        # technical documentation + examples
└── README.md
```

---

## Design overview

### Threat model & privacy

The contract **never** stores personal data, vote content, or the identity of
voters in clear. Only opaque hashes go on-chain:

- `metadataHash` — `keccak256` of the off-chain election document (title,
  description, options, eligibility rules…). The backend keeps the original
  document and can prove its integrity by re-hashing it.
- `voterCommitmentHash` — opaque, deterministic commitment that the backend
  derives from the user identity for a given election, e.g.
  `keccak256(userId, electionId, salt)`. It is the **uniqueness key** that
  prevents double voting.
- `voteHash` — opaque hash of the ballot, e.g. `keccak256(choice, salt)`.

The plain values (user, choice, salt) live exclusively in the backend
database, encrypted at rest. On-chain, observers can audit *that* a vote
happened, count votes per election, and verify nobody voted twice — but they
cannot tell *who* voted *what*.

### Election lifecycle

`ElectionStatus` is **time-driven** and computed on the fly:

```
                manuallyClosed == true
       ┌─────────────────────────────────────┐
       │                                     ▼
   Created ───▶ Active ───────────▶ Closed
   (now < start)   (start ≤ now ≤ end)   (now > end)
```

- `createElection` — owner-only, requires future `startTime` and
  `endTime > startTime`.
- `openElection` — owner-only "open early": snaps `startTime` to `block.timestamp`.
- `closeElection` — owner-only emergency stop: forces status `Closed` and
  snaps `endTime` to `block.timestamp` if still in the future.
- `castVote` — open to any signer, but the `voterCommitmentHash` must be
  fresh and the election must currently be `Active`.

### Authorization

`Ownable` (OpenZeppelin v5). The deployer (or `INITIAL_OWNER` env) is set
as the only admin. Ownership can be transferred or renounced through the
inherited `transferOwnership` / `renounceOwnership` flows.

---

## Public API

| Function | Caller | Description |
| --- | --- | --- |
| `createElection(metadataHash, startTime, endTime)` | owner | creates a new election, returns its `electionId` |
| `openElection(electionId)` | owner | opens an election before its scheduled start |
| `closeElection(electionId)` | owner | manually closes an election (emergency stop) |
| `castVote(electionId, voterCommitmentHash, voteHash)` | anyone | records a vote if active and not duplicated |
| `hasUserVoted(electionId, voterCommitmentHash)` → `bool` | view | uniqueness check |
| `getElection(electionId)` → `(metadataHash, startTime, endTime, totalVotes, status)` | view | full record |
| `getStatus(electionId)` → `ElectionStatus` | view | computed status |
| `electionCount()` → `uint256` | view | total elections (next id is `count`) |

### Events

- `ElectionCreated(electionId, metadataHash, startTime, endTime)`
- `ElectionOpened(electionId, newStartTime)`
- `ElectionClosed(electionId, closedAt)`
- `VoteCast(electionId, voterCommitmentHash, voteHash, timestamp)`

### Custom errors

`InvalidTimeWindow`, `StartTimeInPast`, `EmptyMetadataHash`,
`ElectionNotFound`, `ElectionAlreadyStarted`, `ElectionAlreadyClosed`,
`ElectionNotActive(status)`, `EmptyVoterCommitment`, `EmptyVoteHash`,
`AlreadyVoted`.

These are gas-cheaper than string `require`s and surface structured data to
the backend's transaction parser.

---

## Commands

All commands run from the `contracts/` directory.

### Install

```bash
npm install
```

### Compile

```bash
npm run compile
```

Generates artifacts in `artifacts/` and TypeScript typings in
`typechain-types/`.

### Test

```bash
npm test
```

Runs the full Mocha suite against the in-process Hardhat network.
Expected output: **29 passing**.

Optional gas report:

```bash
npm run test:gas
```

### Deploy — local Hardhat (in-process)

Quick smoke test against a throwaway in-process node:

```bash
npm run deploy:hardhat
```

Writes `deployments/hardhat.json`.

### Deploy — local Hardhat node

Two-terminal workflow you'll use during day-to-day development with the
backend:

```bash
# Terminal 1 — keep running
npx hardhat node
```

```bash
# Terminal 2
npm run deploy:local
```

The first command starts a local JSON-RPC node on
`http://127.0.0.1:8545` (chainId `31337`) and prints 20 funded test
accounts. The second deploys `VotingRegistry` against it and writes
`deployments/localhost.json` with the deployed address — the backend can
read this manifest to bootstrap the contract client.

### Optional: override the initial owner

```bash
$env:INITIAL_OWNER="0xYourMultisigOrAdminAddress"   # PowerShell
npm run deploy:local
```

```bash
INITIAL_OWNER=0xYourMultisigOrAdminAddress npm run deploy:local   # bash
```

### Deploy — testnet

> Per le scelte concordate, in questa fase è configurata solo la rete
> Hardhat. Per estendere a Sepolia / Polygon Amoy / Base Sepolia basta
> aggiungere la sezione corrispondente in `hardhat.config.js` con un
> provider URL (Alchemy/Infura) e una private key da `.env`, poi:
>
> ```bash
> npx hardhat run scripts/deploy.js --network <name>
> ```

---

## Integration notes (per il backend)

Il backend deve:

1. **Hashing deterministico**: derivare `voterCommitmentHash` come
   `keccak256(userId, electionId, salt)` e custodire il `salt` per
   poter (in caso di audit) ricostruire il commitment a partire da un
   user specifico — ma mai esporlo on-chain.
2. **Lock anti-doppio voto in Redis**: prima di inviare la transazione,
   acquisire un lock Redis su chiave
   `vote:lock:{electionId}:{voterCommitmentHash}` con TTL ≥ tempo medio
   di conferma del blocco. Questo evita di pagare gas su transazioni
   che il contratto rifiuterebbe per `AlreadyVoted` ma soprattutto
   protegge da race condition lato API.
3. **Verifica pre-flight**: chiamare `hasUserVoted` e `getStatus` prima
   di firmare/rilanciare la tx per fail-fast con UX migliore.
4. **Indicizzazione eventi**: ascoltare `VoteCast`, `ElectionCreated`,
   `ElectionOpened`, `ElectionClosed` per popolare una proiezione di
   sola lettura in cache (Redis) — utilissimo al frontend per dashboard
   real-time senza martellare l'RPC.
5. **Caching dei metadata**: dato che on-chain c'è solo `metadataHash`,
   il backend serve i dettagli (titolo, opzioni, …) dal DB e può
   verificare l'integrità ricalcolando l'hash.

---

## Sicurezza — checklist applicata

- [x] `Ownable` v5 OpenZeppelin (revert su zero address).
- [x] No dati personali on-chain (solo hash).
- [x] Validazione timestamp (`startTime > now`, `endTime > startTime`).
- [x] Doppio voto impedito via mapping `(electionId => commitment => bool)`.
- [x] Voti respinti se non `Active` (Created/Closed → revert).
- [x] Voti respinti dopo `closeElection` (override manuale).
- [x] Hash non zero (`metadataHash`, `voterCommitmentHash`, `voteHash`).
- [x] Custom errors per audit / debugging strutturato.
- [x] Eventi indicizzati per audit trail completo.
- [x] Test su tutte le branch di accesso e tempo (29 casi).

---

---

## Documentazione tecnica

Per dettagli implementativi, esempi end-to-end (hashing, deploy, voto via
ethers.js, ascolto eventi, integrazione backend Fastify+Redis, gestione
errori e gas) consulta **[`DOCS.md`](./DOCS.md)**.

---

## Licenza

MIT (vedere SPDX header in `VotingRegistry.sol`).
