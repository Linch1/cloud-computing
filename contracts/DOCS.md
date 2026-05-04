# `VotingRegistry` — Documentazione tecnica

Documentazione di riferimento del contratto `VotingRegistry.sol`.
Pensata per chi integra il contratto dal **backend Node.js (Fastify + Redis)**
o dal **frontend Next.js** della piattaforma di voto.

> Tutti gli esempi di codice usano **JavaScript + ethers.js v6**, in linea con
> lo stack del progetto.

---

## Indice

1. [Architettura e modello di privacy](#1-architettura-e-modello-di-privacy)
2. [Storage on-chain in dettaglio](#2-storage-on-chain-in-dettaglio)
3. [Macchina a stati `ElectionStatus`](#3-macchina-a-stati-electionstatus)
4. [Schema di hashing — come si costruiscono i digest](#4-schema-di-hashing--come-si-costruiscono-i-digest)
5. [API completa con esempi](#5-api-completa-con-esempi)
   - [5.1 `createElection`](#51-createelection)
   - [5.2 `openElection`](#52-openelection)
   - [5.3 `closeElection`](#53-closeelection)
   - [5.4 `castVote`](#54-castvote)
   - [5.5 View functions](#55-view-functions)
6. [Eventi e audit trail](#6-eventi-e-audit-trail)
7. [Errori (revert reasons) e parsing lato backend](#7-errori-revert-reasons-e-parsing-lato-backend)
8. [Esempi end-to-end](#8-esempi-end-to-end)
   - [8.1 Deploy con script](#81-deploy-con-script)
   - [8.2 Workflow admin completo](#82-workflow-admin-completo)
   - [8.3 Workflow voto utente](#83-workflow-voto-utente)
   - [8.4 Ascolto eventi `VoteCast` per indicizzazione](#84-ascolto-eventi-votecast-per-indicizzazione)
   - [8.5 Lock anti-doppio voto in Redis](#85-lock-anti-doppio-voto-in-redis)
9. [Gas, costi e considerazioni di scalabilità](#9-gas-costi-e-considerazioni-di-scalabilità)
10. [Limiti del modello (cosa NON fa il contratto)](#10-limiti-del-modello-cosa-non-fa-il-contratto)

---

## 1. Architettura e modello di privacy

```
┌────────────────────────────┐         ┌─────────────────────────────┐
│  Frontend Next.js          │         │  Backend Node.js (Fastify)  │
│  - dashboard admin         │  HTTPS  │  - auth / sessione          │
│  - UI voter                ├────────▶│  - calcolo hash             │
│  - signing via wallet      │         │  - lock Redis               │
└──────────────┬─────────────┘         │  - cache letture on-chain   │
               │                       └──────────────┬──────────────┘
               │ JSON-RPC (eth_call/eth_sendRawTx)    │
               ▼                                      │
        ┌─────────────────────────────────────────────▼─┐
        │             Chain EVM (Hardhat / L1 / L2)     │
        │                                               │
        │   VotingRegistry.sol                          │
        │   - solo HASH on-chain                        │
        │   - Ownable per admin                         │
        │   - eventi indicizzabili per audit            │
        └───────────────────────────────────────────────┘
```

**Principio fondamentale**: il contratto è un *registro pubblico append-only di
hash*. Non sa chi sta votando, non sa cosa stanno votando, non sa nemmeno
qual è il titolo dell'elezione. Espone semplicemente:

- *qualcuno* (identificato dal commitment X) ha votato (con voto Y) all'elezione N
  in un certo timestamp;
- ognuna di queste tuple è univoca per `(electionId, commitment)`;
- la finestra temporale è quella scritta on-chain alla creazione (o aggiornata
  dall'owner).

La risoluzione `commitment → utente` e `voteHash → scelta` vive solo nel
backend, opportunamente cifrata.

---

## 2. Storage on-chain in dettaglio

```solidity
struct Election {
    bytes32 metadataHash;   // hash dei metadata off-chain
    uint64  startTime;      // timestamp inizio (UTC)
    uint64  endTime;        // timestamp fine (UTC)
    uint128 totalVotes;     // counter incrementato da castVote
    bool    manuallyClosed; // override emergency stop
    bool    exists;         // sentinel per distinguere id non assegnati
}

uint256 private _nextElectionId;
mapping(uint256 => Election) private _elections;
mapping(uint256 => mapping(bytes32 => bool)) private _hasVoted;
```

**Note di layout** (utili per i gas-cost estimator):

- `Election` è impacchettata in **2 storage slot**: slot 0 = `metadataHash`
  (32 byte); slot 1 = `startTime|endTime|totalVotes|manuallyClosed|exists`
  (8 + 8 + 16 + 1 + 1 byte = 34, però Solidity li allinea in un singolo slot
  perché 8+8+16=32 byte e i due `bool` finiscono nello stesso slot grazie al
  packing — il dimensionamento `uint128` di `totalVotes` è scelto proprio per
  mantenere il pacchetto compatto).
- Le mapping sono sparse, cioè: leggere `_hasVoted[id][bytes32(0xff..)]`
  ritorna `false` senza errore. Il check `exists` serve a distinguere
  "elezione non ancora creata" da "elezione esistente con dati vuoti".
- `electionId` è 0-indicizzato e sequenziale (`0, 1, 2, ...`). Il backend
  può usare lo stesso id come PK nel proprio DB.

---

## 3. Macchina a stati `ElectionStatus`

```
                     manuallyClosed = true
              ┌──────────────────────────────────────┐
              │                                      ▼
        ┌──────────┐ now ≥ start  ┌─────────┐ now > end ┌─────────┐
        │ Created  │─────────────▶│ Active  │──────────▶│ Closed  │
        └──────────┘              └─────────┘           └─────────┘
              │                                              ▲
              │ closeElection()                              │
              └──────────────────────────────────────────────┘
```

Lo stato è **calcolato** ogni volta da `_statusOf()`:

```solidity
function _statusOf(Election storage e) internal view returns (ElectionStatus) {
    if (e.manuallyClosed) return ElectionStatus.Closed;
    if (block.timestamp < e.startTime) return ElectionStatus.Created;
    if (block.timestamp <= e.endTime) return ElectionStatus.Active;
    return ElectionStatus.Closed;
}
```

Conseguenze pratiche:

- Non c'è una transazione di "auto-attivazione": il primo `castVote` valido
  dopo `startTime` *fotografa* l'elezione come `Active`.
- L'admin può **anticipare** l'apertura via `openElection` (sposta
  `startTime = block.timestamp`) o **forzare** la chiusura via
  `closeElection` (setta `manuallyClosed = true`).
- Una volta `manuallyClosed`, l'elezione non può più essere riaperta.
  Questo è voluto: un'elezione chiusa per emergenza non deve poter
  riaccettare voti senza tracciabilità (la proprietà di append-only va
  rispettata anche a livello logico).

Mapping numerico dell'enum (utile lato JS):

```javascript
const ElectionStatus = { Created: 0, Active: 1, Closed: 2 };
```

---

## 4. Schema di hashing — come si costruiscono i digest

Il contratto si limita a **memorizzare** tre hash. La loro semantica è
contrattuale tra backend e contratto. Ecco lo schema canonico
suggerito (e usato nei test):

### `metadataHash`

Hash del documento di metadata che descrive l'elezione. Esempio di documento:

```json
{
  "title": "Voto Direttivo 2026",
  "description": "Elezione del nuovo direttivo annuale.",
  "options": ["Lista A", "Lista B", "Scheda Bianca"],
  "eligibilityRule": "all-active-members",
  "createdAt": "2026-04-29T08:00:00Z"
}
```

Calcolo:

```javascript
const { ethers } = require("ethers");

const metadata = { title: "...", options: ["A", "B"], /* ... */ };
const metadataJson = JSON.stringify(metadata);
const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(metadataJson));
// es. 0x9f4b...e0
```

> **Convenzione importante**: serializza il JSON in modo *deterministico*
> (chiavi ordinate, no spazi). Altrimenti due backend diversi calcolerebbero
> hash diversi. Una libreria come `json-stable-stringify` aiuta.

### `voterCommitmentHash`

Identifica univocamente un voter all'interno di una specifica elezione,
**senza rivelarne l'identità**.

```javascript
function commitmentFor(userId, electionId, salt) {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["string", "uint256", "string"],
      [userId, electionId, salt],
    ),
  );
}
```

- `userId`: identificativo interno dell'utente (es. UUID dal DB).
- `electionId`: `uint256` dell'elezione.
- `salt`: stringa segreta del backend (non per-utente, ma per-elezione,
  oppure una pepper globale del contratto). Senza il salt un attaccante
  che conosce un `userId` potrebbe ricostruire il commitment via
  brute-force degli ID e tracciare chi ha votato.

> **Trade-off**: usare un salt *per-elezione* (custodito nel DB con
> autorizzazioni rigide) impedisce che chi ottiene un dump del DB
> ricolleghi voti passati a utenti.

### `voteHash`

Hash della scelta espressa.

```javascript
function voteHashFor(choice, salt) {
  return ethers.keccak256(
    ethers.solidityPacked(["string", "string"], [choice, salt]),
  );
}
```

- `choice`: stringa canonica della scelta (es. `"OPTION_A"`,
  `"BLANK"`). Deve coincidere ESATTAMENTE con uno dei valori in
  `metadata.options`.
- `salt`: salt per-voto (random, generato dal backend per ogni voto).
  Senza salt, due voti per la stessa scelta produrrebbero lo stesso
  hash → un osservatore on-chain riuscirebbe a fare un istogramma
  delle preferenze in tempo reale, vanificando la confidenzialità
  intermedia. Con salt random è impossibile.

> **Conteggio**: dato che ogni `voteHash` è unico, il conteggio NON
> avviene on-chain. Il backend mantiene la mappa
> `voteHash → choice` (cifrata) e a chiusura elezione esegue il
> tally. Per audit pubblico, il backend pubblica off-chain il dump
> `(voteHash, choice, salt)` di tutti i voti: chiunque può
> ricalcolare gli hash e confrontarli con gli eventi `VoteCast` on-chain.

---

## 5. API completa con esempi

Tutti gli esempi assumono:

```javascript
const { ethers } = require("ethers");
const ABI = require("./artifacts/contracts/VotingRegistry.sol/VotingRegistry.json").abi;

const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const signer = await provider.getSigner(0);
const registry = new ethers.Contract(REGISTRY_ADDRESS, ABI, signer);
```

### 5.1 `createElection`

```solidity
function createElection(
    bytes32 metadataHash,
    uint256 startTime,
    uint256 endTime
) external onlyOwner returns (uint256 electionId);
```

- **Caller**: solo `owner`.
- **Pre**: `metadataHash != 0`, `startTime > now`, `endTime > startTime`,
  `endTime <= type(uint64).max`.
- **Post**: nuova `Election` salvata con `totalVotes = 0`,
  `manuallyClosed = false`, `exists = true`. Emesso `ElectionCreated`.
- **Reverts**: `EmptyMetadataHash`, `InvalidTimeWindow`,
  `StartTimeInPast`, `OwnableUnauthorizedAccount`.

```javascript
const startTime = Math.floor(Date.now() / 1000) + 60;       // tra 1 min
const endTime   = startTime + 24 * 60 * 60;                  // 24h dopo
const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(metadata)));

const tx = await registry.createElection(metadataHash, startTime, endTime);
const receipt = await tx.wait();

// Recupero electionId dal log emesso
const evt = receipt.logs
  .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
  .find((p) => p && p.name === "ElectionCreated");
const electionId = evt.args.electionId;       // BigInt
console.log("Election creata:", electionId.toString());
```

### 5.2 `openElection`

```solidity
function openElection(uint256 electionId) external onlyOwner;
```

- **Caller**: solo `owner`.
- **Pre**: l'elezione esiste, `now < startTime`, non `manuallyClosed`.
- **Post**: `startTime = block.timestamp` → status diventa `Active`.
  Emesso `ElectionOpened`.
- **Reverts**: `ElectionNotFound`, `ElectionAlreadyStarted`,
  `ElectionAlreadyClosed`, `OwnableUnauthorizedAccount`.

```javascript
await registry.openElection(electionId);
console.log("Status:", await registry.getStatus(electionId)); // 1 = Active
```

### 5.3 `closeElection`

```solidity
function closeElection(uint256 electionId) external onlyOwner;
```

- **Caller**: solo `owner`.
- **Pre**: l'elezione esiste e non è già `manuallyClosed`.
- **Post**: `manuallyClosed = true`. Se `now < endTime`, anche
  `endTime = block.timestamp` (così le query temporali off-chain vedono
  l'elezione come terminata). Emesso `ElectionClosed`.
- **Effetto irreversibile**: una elezione chiusa manualmente non
  può essere riaperta.

```javascript
await registry.closeElection(electionId);
```

### 5.4 `castVote`

```solidity
function castVote(
    uint256 electionId,
    bytes32 voterCommitmentHash,
    bytes32 voteHash
) external;
```

- **Caller**: chiunque (ogni signer con ETH per il gas).
- **Pre**:
  - `voterCommitmentHash != 0`, `voteHash != 0`;
  - l'elezione esiste e il suo status è `Active`;
  - `_hasVoted[electionId][voterCommitmentHash] == false`.
- **Post**:
  - `_hasVoted[electionId][voterCommitmentHash] = true`;
  - `totalVotes += 1`;
  - Emesso `VoteCast(electionId, voterCommitmentHash, voteHash, block.timestamp)`.
- **Reverts**: `EmptyVoterCommitment`, `EmptyVoteHash`,
  `ElectionNotFound`, `ElectionNotActive(status)`, `AlreadyVoted`.

```javascript
const userId = "user_42";
const electionId = 0n;
const choice = "OPTION_A";

const commitment = ethers.keccak256(
  ethers.solidityPacked(
    ["string", "uint256", "string"],
    [userId, electionId, ELECTION_SALT],
  ),
);
const vHash = ethers.keccak256(
  ethers.solidityPacked(["string", "string"], [choice, randomSaltPerVote()]),
);

const tx = await registry.connect(userSigner).castVote(electionId, commitment, vHash);
await tx.wait();
```

### 5.5 View functions

```solidity
function hasUserVoted(uint256 electionId, bytes32 voterCommitmentHash) external view returns (bool);
function getElection(uint256 electionId) external view returns (
    bytes32 metadataHash,
    uint64  startTime,
    uint64  endTime,
    uint128 totalVotes,
    ElectionStatus status
);
function getStatus(uint256 electionId) external view returns (ElectionStatus);
function electionCount() external view returns (uint256);
function owner() external view returns (address);  // ereditata da Ownable
```

```javascript
// Lettura dati elezione (NON costa gas — eth_call)
const e = await registry.getElection(0);
console.log({
  metadataHash: e.metadataHash,
  startTime: Number(e.startTime),
  endTime: Number(e.endTime),
  totalVotes: e.totalVotes.toString(),
  status: ["Created", "Active", "Closed"][Number(e.status)],
});

// Check anti-doppio voto pre-flight (UX migliore: niente revert in tx)
const already = await registry.hasUserVoted(0, commitment);
if (already) throw new Error("Hai già votato in questa elezione.");
```

---

## 6. Eventi e audit trail

```solidity
event ElectionCreated(uint256 indexed electionId, bytes32 indexed metadataHash, uint64 startTime, uint64 endTime);
event ElectionOpened (uint256 indexed electionId, uint64 newStartTime);
event ElectionClosed (uint256 indexed electionId, uint64 closedAt);
event VoteCast       (uint256 indexed electionId, bytes32 indexed voterCommitmentHash, bytes32 voteHash, uint64 timestamp);
```

I campi `indexed` permettono filtri `eth_getLogs` efficienti:

```javascript
// Tutti i voti dell'elezione 7
const voteCastFilter = registry.filters.VoteCast(7n);
const logs = await registry.queryFilter(voteCastFilter, fromBlock, toBlock);
console.log(`${logs.length} voti registrati per l'elezione 7`);

// Tutti i voti di un dato commitment (debug / audit per uno specifico utente)
const userFilter = registry.filters.VoteCast(null, commitment);
```

> **Nota sull'`indexed bytes32`**: il valore intero è preservato (a
> differenza di `indexed string`/`indexed bytes` che vengono *hashed*).
> Quindi `voterCommitmentHash` e `metadataHash` sono pienamente
> filtrabili.

### Listener real-time per il backend

```javascript
registry.on("VoteCast", (electionId, commitment, voteHash, timestamp, evt) => {
  // 1. Aggiorna la cache Redis (es. counter per elezione)
  redis.incr(`election:${electionId}:totalVotes`);
  redis.set(`vote:${electionId}:${commitment}`, voteHash, "EX", 86_400);

  // 2. Loga in audit trail persistente
  auditLog.push({
    type: "VoteCast",
    electionId: electionId.toString(),
    commitment,
    voteHash,
    blockNumber: evt.log.blockNumber,
    txHash: evt.log.transactionHash,
    timestamp: Number(timestamp),
  });
});
```

---

## 7. Errori (revert reasons) e parsing lato backend

Il contratto usa **custom errors** (più gas-efficient delle stringhe e con
parametri strutturati). Ecco la tabella completa con strategia di
gestione consigliata lato backend:

| Errore | Trigger | Cosa fare nel backend |
|---|---|---|
| `OwnableUnauthorizedAccount(address)` | call admin da non-owner | 403 Forbidden, log security |
| `OwnableInvalidOwner(address)` | constructor con `address(0)` | bug di deploy, alert ops |
| `EmptyMetadataHash` | `metadataHash == 0` in `createElection` | 400 Bad Request, validare input |
| `InvalidTimeWindow(start, end)` | `start >= end` o overflow | 400, mostrare validazione date |
| `StartTimeInPast(start, now)` | `start <= now` | 400, suggerire shift in avanti |
| `ElectionNotFound(id)` | id mai assegnato | 404 Not Found |
| `ElectionAlreadyStarted(id)` | `openElection` su election in corso | 409 Conflict |
| `ElectionAlreadyClosed(id)` | open/close su election già chiusa | 409 Conflict |
| `ElectionNotActive(id, status)` | `castVote` quando non `Active` | 409, mostrare status corrente |
| `EmptyVoterCommitment` | commitment zero in `castVote` | 400, bug client/backend |
| `EmptyVoteHash` | voteHash zero in `castVote` | 400, idem |
| `AlreadyVoted(id, commitment)` | doppio voto | 409, "Hai già votato" |

### Parsing tipico

```javascript
async function safeCall(fn) {
  try {
    return await fn();
  } catch (err) {
    // ethers v6: i custom error finiscono in err.revert.name e err.revert.args
    const revert = err.revert || (err.info && err.info.error && err.info.error.data);
    const errorName = revert?.name || "Unknown";

    switch (errorName) {
      case "AlreadyVoted":
        throw new HttpError(409, "Hai già votato in questa elezione.");
      case "ElectionNotActive": {
        const status = ["Created", "Active", "Closed"][Number(revert.args[1])];
        throw new HttpError(409, `Elezione in stato ${status}, voto non consentito.`);
      }
      case "OwnableUnauthorizedAccount":
        throw new HttpError(403, "Operazione riservata all'admin.");
      default:
        throw err; // bubble up
    }
  }
}
```

---

## 8. Esempi end-to-end

### 8.1 Deploy con script

```bash
# Terminale 1 — nodo locale persistente
npx hardhat node
```

```bash
# Terminale 2 — deploy
npm run deploy:local
# ↳ scrive deployments/localhost.json:
#   {
#     "network": "localhost",
#     "chainId": 31337,
#     "contract": "VotingRegistry",
#     "address": "0x5FbDB2315678afecb367f032d93F642f64180aa3",
#     "initialOwner": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
#     ...
#   }
```

### 8.2 Workflow admin completo

```javascript
const { ethers } = require("ethers");
const fs = require("fs");

const ABI = JSON.parse(
  fs.readFileSync("./artifacts/contracts/VotingRegistry.sol/VotingRegistry.json"),
).abi;
const { address } = JSON.parse(fs.readFileSync("./deployments/localhost.json"));

const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const adminSigner = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
const registry = new ethers.Contract(address, ABI, adminSigner);

// 1. Compongo i metadata e calcolo l'hash
const metadata = {
  title: "Direttivo 2026",
  options: ["Lista A", "Lista B", "Scheda Bianca"],
  createdAt: new Date().toISOString(),
};
const metaHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(metadata)));

// 2. Creo l'elezione (start tra 5 min, durata 24h)
const start = Math.floor(Date.now() / 1000) + 5 * 60;
const end   = start + 24 * 3600;
const txCreate = await registry.createElection(metaHash, start, end);
const rcCreate = await txCreate.wait();
const electionId = rcCreate.logs
  .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
  .find((p) => p && p.name === "ElectionCreated").args.electionId;

console.log("Election creata:", electionId.toString());

// 3. (opzionale) apertura anticipata
// await registry.openElection(electionId);

// 4. ... voti registrati ...

// 5. Chiusura manuale (emergency stop)
// await registry.closeElection(electionId);

// 6. Lettura risultati grezzi
const e = await registry.getElection(electionId);
console.log("Voti totali:", e.totalVotes.toString());
```

### 8.3 Workflow voto utente

Lato frontend Next.js, l'utente firma direttamente con MetaMask /
WalletConnect. Il backend prepara i parametri (commitment + voteHash) e
li passa al frontend; il frontend chiede la firma utente.

**Step backend (calcolo hash + lock + handoff):**

```javascript
// POST /api/elections/:id/prepare-vote
fastify.post("/api/elections/:id/prepare-vote", async (req, reply) => {
  const userId = req.session.userId;
  const electionId = BigInt(req.params.id);
  const choice = req.body.choice;

  const electionMeta = await db.elections.findById(electionId);
  if (!electionMeta.options.includes(choice)) {
    return reply.code(400).send({ error: "Scelta non valida." });
  }

  const commitment = ethers.keccak256(
    ethers.solidityPacked(
      ["string", "uint256", "string"],
      [userId, electionId, electionMeta.commitmentSalt],
    ),
  );

  // Lock anti-doppio voto in Redis (più stringente del check on-chain)
  const lockKey = `vote:lock:${electionId}:${commitment}`;
  const acquired = await redis.set(lockKey, "1", "NX", "EX", 120);
  if (!acquired) return reply.code(409).send({ error: "Voto già in elaborazione." });

  // Pre-flight on-chain
  const already = await registry.hasUserVoted(electionId, commitment);
  if (already) {
    await redis.del(lockKey);
    return reply.code(409).send({ error: "Hai già votato." });
  }

  const voteSalt = crypto.randomBytes(32).toString("hex");
  const voteHash = ethers.keccak256(
    ethers.solidityPacked(["string", "string"], [choice, voteSalt]),
  );

  await db.votesPending.insert({
    userId, electionId, choice, voteSalt, commitment, voteHash,
    createdAt: new Date(),
  });

  return {
    contractAddress: registry.target,
    electionId: electionId.toString(),
    commitment,
    voteHash,
  };
});
```

**Step frontend (firma e invio tx):**

```javascript
// hooks/useCastVote.js
import { ethers } from "ethers";
import VotingRegistryABI from "@/abi/VotingRegistry.json";

export async function castVote({ contractAddress, electionId, commitment, voteHash }) {
  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const registry = new ethers.Contract(contractAddress, VotingRegistryABI, signer);

  const tx = await registry.castVote(BigInt(electionId), commitment, voteHash);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}
```

**Step backend (conferma post-tx):**

```javascript
// POST /api/elections/:id/confirm-vote { txHash }
fastify.post("/api/elections/:id/confirm-vote", async (req, reply) => {
  const { txHash } = req.body;
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) {
    return reply.code(400).send({ error: "Transazione non confermata." });
  }

  // Verifica evento VoteCast nella tx
  const evt = receipt.logs
    .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
    .find((p) => p && p.name === "VoteCast");
  if (!evt) return reply.code(400).send({ error: "Evento VoteCast non trovato." });

  await db.votesPending.markConfirmed(evt.args.voterCommitmentHash, txHash);
  return { ok: true };
});
```

### 8.4 Ascolto eventi `VoteCast` per indicizzazione

```javascript
// indexer.js — runa come worker dedicato
const { ethers } = require("ethers");
const Redis = require("ioredis");
const ABI = require("./artifacts/contracts/VotingRegistry.sol/VotingRegistry.json").abi;

const provider = new ethers.WebSocketProvider(process.env.WS_RPC_URL);
const registry = new ethers.Contract(process.env.REGISTRY_ADDRESS, ABI, provider);
const redis = new Redis(process.env.REDIS_URL);

async function backfill(fromBlock, toBlock) {
  const filter = registry.filters.VoteCast();
  const logs = await registry.queryFilter(filter, fromBlock, toBlock);
  for (const log of logs) {
    await persistVote(log);
  }
}

async function persistVote(log) {
  const { electionId, voterCommitmentHash, voteHash, timestamp } = log.args;
  const key = `vote:${electionId}:${voterCommitmentHash}`;
  await redis.hset(key, {
    voteHash,
    timestamp: Number(timestamp),
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
  });
  await redis.incr(`election:${electionId}:counter`);
}

// 1. Backfill al boot (recupero eventi persi)
const lastBlock = Number(await redis.get("indexer:lastBlock")) || 0;
const head = await provider.getBlockNumber();
await backfill(lastBlock + 1, head);
await redis.set("indexer:lastBlock", head);

// 2. Live streaming
registry.on("VoteCast", async (...args) => {
  const log = args[args.length - 1].log;
  await persistVote({ args: { electionId: args[0], voterCommitmentHash: args[1], voteHash: args[2], timestamp: args[3] }, ...log });
  await redis.set("indexer:lastBlock", log.blockNumber);
});
```

### 8.5 Lock anti-doppio voto in Redis

Il check `_hasVoted` on-chain è autoritativo, ma:

- viene effettuato solo a `castVote` minato → c'è una finestra
  (~secondi/minuti) in cui l'utente potrebbe inviare una seconda
  richiesta;
- pagare gas per una transazione che il contratto rifiuterà è uno spreco
  e una pessima UX.

Soluzione: lock distribuito Redis con `SET NX EX`:

```javascript
async function acquireVoteLock(redis, electionId, commitment, ttlSec = 120) {
  const key = `vote:lock:${electionId}:${commitment}`;
  const ok = await redis.set(key, "locked", "NX", "EX", ttlSec);
  return ok === "OK";
}

async function releaseVoteLock(redis, electionId, commitment) {
  const key = `vote:lock:${electionId}:${commitment}`;
  await redis.del(key);
}
```

Flusso completo:

1. acquireVoteLock → se fallisce, **409 Conflict** (voto in corso).
2. `hasUserVoted` on-chain → se `true`, rilascia lock e **409**.
3. Prepara `voteHash`, salva pending.
4. Frontend firma e invia `castVote`.
5. Backend ascolta `VoteCast` (vedi 8.4) e marca confermato.
6. Se la tx fallisce o scade il TTL → lock rilasciato automaticamente.

---

## 9. Gas, costi e considerazioni di scalabilità

Numeri indicativi (chain `paris`, optimizer `runs: 200`, ottenuti dal
test suite con `npm run test:gas`):

| Operazione | Gas approssimativo |
|---|---:|
| `createElection` | ~110k |
| `openElection` | ~32k |
| `closeElection` | ~32k |
| `castVote` (voto nuovo) | ~75k |
| `castVote` (voto duplicato, revert) | ~25k |
| `getElection` (view, eth_call) | 0 |

Considerazioni:

- **Storage cost**: ogni voto scrive UNA storage slot nuova (`_hasVoted`).
  Con SSTORE da zero a non-zero ~ 20k gas + overhead intrinseco.
- **Su L1 Ethereum** un voto costerebbe alcuni dollari. Per produzione
  realistica si consiglia un **L2** (Base, Optimism, Arbitrum) o una
  chain a gas bassi (Polygon).
- **Upgrade**: il contratto è non-upgradabile. Per evolvere lo schema si
  fa redeploy + migrazione off-chain (gli eventi storici restano leggibili
  dalla vecchia istanza).
- **Throughput**: `castVote` è lock-free a livello di mapping; voti su
  elezioni *diverse* non si pestano i piedi. Voti sulla *stessa*
  elezione condividono lo slot `totalVotes` e quindi si serializzano sul
  block, ma è un costo trascurabile rispetto alla SSTORE del mapping.

---

## 10. Limiti del modello (cosa NON fa il contratto)

Per chiarezza con stakeholder e auditor:

1. **Non verifica eligibility**. Chiunque conosca un commitment "vergine"
   può votare. La protezione è demandata al backend (autenticazione,
   firma del commitment lato server, …). Per spostare l'eligibility
   on-chain si dovrebbe pubblicare una Merkle root degli eleggibili e
   richiedere proof in `castVote` (estensione futura).
2. **Non garantisce segretezza assoluta**. Se il backend viene
   compromesso e l'attaccante ottiene gli salt + il mapping userId/choice,
   la corrispondenza tra utenti e voti diventa ricostruibile. Per
   segretezza forte si dovrebbe passare a uno schema commit-reveal o
   ZK (es. Semaphore).
3. **Non conta i voti on-chain**. `totalVotes` è solo un counter; il
   tally per scelta è eseguito off-chain. Se serve trasparenza completa,
   la pubblicazione post-elezione di tutti i `(voteHash, choice, salt)`
   permette ricalcolo indipendente, ma rivela le scelte (per design,
   solo a elezione chiusa).
4. **Non gestisce identità wallet ↔ user**. Il modello di firma scelto
   (utente con wallet) implica che il backend mantenga un mapping
   `address ↔ userId`. Il contratto non lo fa né si aspetta che l'EOA
   firmataria coincida con il "voter" logico — la verifica è
   esclusivamente sul `voterCommitmentHash`.
5. **Non implementa pause globale o blacklist**. Per un emergency-stop
   trasversale sarebbe necessario `Pausable`; per ora `closeElection`
   per singola elezione è la valvola di sicurezza.

---

## Riferimenti

- OpenZeppelin Ownable v5: https://docs.openzeppelin.com/contracts/5.x/api/access#Ownable
- ethers.js v6: https://docs.ethers.org/v6/
- Hardhat: https://hardhat.org/docs
- Solidity custom errors: https://soliditylang.org/blog/2021/04/21/custom-errors/
