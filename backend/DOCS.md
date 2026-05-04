# Backend Fastify — Documentazione tecnica

Documentazione di riferimento del backend Node.js della piattaforma di voto.
Si rivolge a chi deve **operare**, **estendere** o **auditare** il server.
Per il contratto vedi [`../contracts/DOCS.md`](../contracts/DOCS.md). Per il
riassunto operativo vedi [`README.md`](./README.md). Per gli endpoint vedi
[`API.md`](./API.md).

> Tutti gli esempi di codice usano **JavaScript ESM** (Node ≥ 20) e seguono
> lo stesso stile del codice in `src/`. Niente TypeScript.

---

## Indice

1. [Architettura ad alto livello](#1-architettura-ad-alto-livello)
2. [Stack e motivazioni](#2-stack-e-motivazioni)
3. [Lifecycle dell'applicazione](#3-lifecycle-dellapplicazione)
4. [Configurazione e ambiente](#4-configurazione-e-ambiente)
5. [Plugin Fastify](#5-plugin-fastify)
   - [5.1 errorHandler](#51-errorhandler)
   - [5.2 redis](#52-redis)
   - [5.3 auth (JWT)](#53-auth-jwt)
   - [5.4 blockchain](#54-blockchain)
   - [5.5 rate-limit, helmet, CORS](#55-rate-limit-helmet-cors)
6. [Layer Repository (Redis)](#6-layer-repository-redis)
7. [Layer Service (logica di business)](#7-layer-service-logica-di-business)
8. [Layer Routes (HTTP)](#8-layer-routes-http)
9. [Schema di hashing](#9-schema-di-hashing)
10. [Flusso del voto in dettaglio](#10-flusso-del-voto-in-dettaglio)
11. [Anti-doppio voto: tre livelli di difesa](#11-anti-doppio-voto-tre-livelli-di-difesa)
12. [Sicurezza (defense in depth)](#12-sicurezza-defense-in-depth)
13. [Logging e redaction](#13-logging-e-redaction)
14. [Gestione errori centralizzata](#14-gestione-errori-centralizzata)
15. [Test e strategia di mocking](#15-test-e-strategia-di-mocking)
16. [Threat model e limiti](#16-threat-model-e-limiti)
17. [Estensione del backend](#17-estensione-del-backend)
18. [Runbook operativo](#18-runbook-operativo)

---

## 1. Architettura ad alto livello

```
                        ┌──────────────────────────────────────┐
                        │          Frontend Next.js            │
                        │   (admin dashboard + voter UI)       │
                        └───────────────┬──────────────────────┘
                                        │ HTTPS, JSON, JWT Bearer
                                        ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                       Backend Fastify (questo)                      │
   │                                                                     │
   │  ┌── HTTP layer ─────────────────────────────────────────────────┐  │
   │  │  helmet → CORS → errorHandler → routes (zod validate)        │  │
   │  └──────────────────┬───────────────────────────────────────────┘  │
   │                     │                                               │
   │                     ▼                                               │
   │  ┌── Service layer (logica di business, niente HTTP) ───────────┐  │
   │  │  authService · electionService · voteService                 │  │
   │  └──────────┬───────────────────────────┬──────────────────────┘  │
   │             │                           │                         │
   │             ▼                           ▼                         │
   │  ┌── Repositories ───────┐    ┌── Blockchain client ─────────┐  │
   │  │  user / election /    │    │  ethers.Wallet (relayer)    │  │
   │  │  vote (Redis)         │    │  ethers.Contract            │  │
   │  └──────────┬────────────┘    └────────────┬────────────────┘  │
   └─────────────┼─────────────────────────────┼────────────────────┘
                 │                             │
                 ▼                             ▼
        ┌────────────────┐            ┌────────────────────┐
        │     Redis      │            │  Chain EVM (RPC)   │
        │ (storage unico)│            │  VotingRegistry    │
        └────────────────┘            └────────────────────┘
```

**Tre layer separati**:

- **Routes** parlano HTTP, validano input con Zod, applicano `preHandler`
  per auth/role/rate-limit, traducono in chiamate al service. Non
  conoscono Redis né la chain.
- **Services** contengono tutta la logica (regole di business, lock,
  costruzione hash, orchestrazione tx). Non parlano HTTP.
- **Repositories** parlano solo con Redis. Niente logica.
- **`app.chain`** è l'unica porta verso la blockchain. I service la usano
  via dependency injection.

Questa separazione consente al test di **iniettare un Redis in-memory e
una chain mock**, eseguire l'intero stack reale (Fastify + plugin +
service + repo) e testare il backend **senza Redis e senza Hardhat**.

---

## 2. Stack e motivazioni

| Scelta | Motivazione |
| --- | --- |
| **Node ≥ 20, ESM** | `import` nativo, `node --watch`, `node --test`, niente transpilazione. |
| **JavaScript puro** | Vincolo del progetto. JSDoc dove utile (es. `utils/hash.js`). |
| **Fastify 4** | Async/await idiomatico, performance, ecosistema plugin maturo, hooks granulari (`preHandler` per route specifiche). |
| **`@fastify/jwt`** | Integrazione pulita con `req.jwtVerify()` e `app.jwt.sign()`. |
| **`@fastify/rate-limit`** | Backend Redis distribuito incluso, scope per-route via `config.rateLimit`. |
| **`@fastify/helmet`, `@fastify/cors`** | Default sani, configurabili. |
| **`ioredis`** | Pipelining, supporto cluster, integrazione perfetta con `@fastify/rate-limit`. |
| **`zod`** | Schemi runtime + tipi inferiti, errori strutturati, niente JSON-Schema da scrivere a mano. |
| **`bcryptjs`** | Pure JS, niente build nativa (Windows-friendly). Per produzione si può sostituire con `argon2id`. |
| **`ethers` v6** | Stessa libreria del progetto contracts, custom errors decodificabili, `JsonRpcProvider` con `chainId` esplicito (anti chain-id confusion). |
| **`pino`** | Logger JSON di Fastify con redaction nativa di campi sensibili. |
| **`vitest` + `ioredis-mock`** | Esecuzione veloce, drop-in di Redis senza container. |

---

## 3. Lifecycle dell'applicazione

### 3.1 `buildApp(opts)` — fabbrica dell'app

`src/app.js` esporta `buildApp({config, redisClient, chainClient})`. Questa
fabbrica è l'unico punto di costruzione dell'app: viene usata sia da
`server.js` (produzione/dev) sia dai test.

Ordine di registrazione (importante: alcune dipendenze sono runtime):

```
1. errorHandlerPlugin    (deve essere primo per catturare errori dei plugin successivi)
2. helmet + cors         (security headers + cross-origin policy)
3. redisPlugin           (decora app.redis — necessario per rate-limit e repos)
4. rateLimit             (richiede app.redis)
5. authPlugin            (richiede config; decora app.authenticate, app.requireAdmin)
6. blockchainPlugin      (decora app.chain)
7. costruzione repo + service + decorate(app.services)
8. registrazione route   (auth, admin, elections, votes)
```

Tre cose registrate **come decorator**, non come dato locale:

- `app.config` — configurazione validata (vedi §4).
- `app.services` — `{ authService, electionService, voteService }`.
- `app.repositories` — utili nei test per ispezionare lo stato.

### 3.2 `server.js` — bootstrap

```js
async function start() {
  const app = await buildApp();

  // 1) Seed admin idempotente
  await app.services.authService.ensureAdmin({
    email: app.config.ADMIN_EMAIL,
    password: app.config.ADMIN_PASSWORD,
  });

  // 2) Graceful shutdown
  const shutdown = async (sig) => {
    await app.close();          // chiude Fastify -> chiude Redis (onClose)
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  // 3) Listen
  await app.listen({ port: app.config.PORT, host: app.config.HOST });
}
```

Il **seed admin** è eseguito ad ogni avvio: se l'email esiste già è no-op.
Questo garantisce sempre la presenza di almeno un account admin senza
bisogno di script separati.

Lo **shutdown** è "graceful": Fastify chiude le connessioni HTTP attive,
poi esegue gli `onClose` dei plugin → il plugin Redis chiama `client.quit()`
(con fallback `disconnect()` se il quit fallisce).

---

## 4. Configurazione e ambiente

`src/config/index.js` definisce uno schema **Zod** che valida e tipa
l'intero `process.env`. Un errore di config impedisce il boot con un
messaggio chiaro:

```
Invalid environment configuration:
  - JWT_SECRET: JWT_SECRET must be at least 16 chars
  - PRIVATE_KEY: PRIVATE_KEY must be a 0x-prefixed 32-byte hex string
```

Validazioni notevoli:

- `PRIVATE_KEY` deve matchare `^0x[0-9a-fA-F]{64}$` (32 byte).
- `CONTRACT_ADDRESS` deve matchare `^0x[0-9a-fA-F]{40}$` (20 byte).
- `JWT_SECRET` ≥ 16 caratteri (in produzione almeno 32 random).
- `VOTER_HASH_SALT` ≥ 16 caratteri (idem).
- `RPC_URL` deve essere una URL valida.
- `CHAIN_ID` numero positivo: passato a `JsonRpcProvider` per **bloccare
  attacchi di chain-id confusion** (il provider rifiuta una chain con id
  diverso da quanto atteso).

`CORS_ORIGIN` è una lista CSV; il loader la espande in `corsOrigins:
string[]` per il middleware CORS.

I rate-limit hanno valori **conservativi di default** ma sono
configurabili per consentire stress-test e demo:

| Variabile | Default |
| --- | --- |
| `RATE_LIMIT_LOGIN_MAX` | `5` per `RATE_LIMIT_LOGIN_WINDOW = "1 minute"` |
| `RATE_LIMIT_VOTE_MAX`  | `3` per `RATE_LIMIT_VOTE_WINDOW  = "1 minute"` |

---

## 5. Plugin Fastify

Tutti i plugin custom sono **wrappati in `fastify-plugin`** così le loro
decorate (`app.redis`, `app.chain`, `app.authenticate`, ecc.) sono
visibili nel **parent scope** anziché restare incapsulate.

### 5.1 errorHandler

`src/plugins/errorHandler.js` registra `setErrorHandler` e
`setNotFoundHandler`. È il **primo plugin** a essere caricato perché
deve coprire eventuali errori di registrazione dei plugin successivi
(non di Fastify stesso, ma quelli emessi sincroni nei nostri).

Mappa quattro famiglie di errori:

```
ZodError                 → 400 VALIDATION_ERROR  + array `issues`
HttpError (custom)       → status / code / message del nostro tipo
Errore JWT / 4xx vari    → status del Fastify, error code best-effort
429 (rate limit)         → 400+ RATE_LIMITED message
Tutto il resto           → 500 INTERNAL_ERROR (logged come `unhandled`)
```

In **produzione** il `message` di un 500 è oscurato (`"Internal server error"`)
per non leakare dettagli interni. In dev/test viene il `err.message` reale.

### 5.2 redis

`src/plugins/redis.js` decora `app.redis`. Accetta un `opts.client`
opzionale per i test (così i test condividono lo stesso `RedisMock`).

Aggancia `onClose` per chiudere il client: tenta `quit()` (drain pulito),
fallback `disconnect()`. Logga ogni `error` event come warning (Redis
client emette `error` durante riconnessioni transienti — non vogliamo che
buttino giù il processo).

### 5.3 auth (JWT)

`src/plugins/auth.js` registra `@fastify/jwt` con:

- `secret = app.config.JWT_SECRET`
- `sign.expiresIn = app.config.JWT_EXPIRES_IN`

Decora due **preHandler**:

```js
app.authenticate     → req.jwtVerify(); throw 401 UNAUTHORIZED se fallisce
app.requireAdmin     → assume req.user popolato; throw 403 FORBIDDEN se role != "admin"
```

Convenzioni payload JWT:

```json
{
  "sub":   "usr_01HXYZABC...",   // userId, ULID-prefixed
  "email": "alice@example.com",
  "role":  "voter" | "admin",
  "iat":   1735000000,
  "exp":   1735003600
}
```

`req.user` è popolato da `@fastify/jwt` con il payload decodificato.
**Niente sessioni Redis**: JWT stateless puro (decisione presa con
l'utente in fase 0). Conseguenza: il logout è "client-side" (cestinare
il token). Per revoca server-side aggiungere una blacklist `jti` su
Redis con TTL = `exp - now` — non implementato in questa fase.

### 5.4 blockchain

`src/plugins/blockchain.js` è la **sola porta** verso la chain. Esporta
un oggetto `app.chain` con un'API ad alto livello che incapsula:

- creazione `JsonRpcProvider(RPC_URL, {chainId, name})` — il chainId
  esplicito blocca un RPC che mente sull'identità della chain;
- `Wallet(PRIVATE_KEY, provider)` — il **relayer** (deve essere l'owner
  del contratto);
- `Contract(CONTRACT_ADDRESS, abi, wallet)` — l'istanza chiamabile;
- helper `createElection`, `openElection`, `closeElection`, `castVote`,
  `getElection`, `getStatus`, `hasUserVoted`.

Esempio non banale: `createElection` deve estrarre l'`electionId`
dall'evento `ElectionCreated` perché il contratto restituisce il valore
solo come ritorno della tx (non leggibile post-mining senza eventi):

```js
const tx = await contract.createElection(metadataHash, startTime, endTime);
const receipt = await tx.wait();
let electionId = null;
for (const log of receipt.logs) {
  try {
    const parsed = contract.interface.parseLog(log);
    if (parsed?.name === "ElectionCreated") {
      electionId = parsed.args.electionId.toString();
      break;
    }
  } catch { /* log non nostro */ }
}
return { txHash: receipt.hash, blockNumber: receipt.blockNumber, electionId };
```

Per i test, il plugin onora `opts.client` e bypassa completamente la
costruzione del provider — `app.chain` diventa il **mock in-memory** che
imita le invariant del contratto reale (`mockChain.js`).

### 5.5 rate-limit, helmet, CORS

- **helmet** — abilitato con `contentSecurityPolicy: false` (la CSP la
  imposterà il frontend; per un'API JSON pura helmet imposta comunque
  `X-Content-Type-Options`, `X-DNS-Prefetch-Control`,
  `Strict-Transport-Security`, ecc.).
- **cors** — origin function che accetta richieste senza `Origin` (es.
  curl, server-to-server) e confronta contro `corsOrigins`. Supporta `*`
  per dev. `credentials: true` per consentire cookie se in futuro li
  introduciamo.
- **rate-limit** — registrato con `global: false` perché **non vogliamo**
  che si applichi a tutte le route. Ogni route che lo richiede dichiara
  esplicitamente `config.rateLimit` (login, vote). Backend Redis
  condiviso, namespace `rl:` per non collidere con le altre chiavi. Il
  `keyGenerator` è custom:

  ```js
  // login: per ip + email per evitare che un attaccante saturi l'IP
  // di tutti i tentativi su un account
  keyGenerator: (req) => `login:${req.ip}:${(req.body?.email || "").toLowerCase()}`

  // vote: per userId (lo conosciamo già, siamo dopo authenticate)
  keyGenerator: (req) => `vote:${req.user?.sub ?? req.ip}`
  ```

---

## 6. Layer Repository (Redis)

Tutti i repository sono **funzioni factory** che ricevono il client
`redis` e ritornano un oggetto di metodi async. Non c'è una classe
`Repository` astratta: il duck typing è sufficiente e si sposa bene con
i mock.

### 6.1 Schema chiavi

| Chiave | Tipo | Contenuto | TTL |
| --- | --- | --- | --- |
| `user:{userId}` | hash | `id, email, passwordHash, role, createdAt` | nessuno |
| `user_email:{email}` | string | `userId` (indice secondario) | nessuno |
| `election:{electionId}` | string | JSON con metadata completa | nessuno |
| `election:list` | set | tutti gli `electionId` | nessuno |
| `vote:{electionId}:{userId}` | string | JSON con prova del voto + scelta | nessuno |
| `lock:vote:{electionId}:{userId}` | string | `"1"` | 30 s (NX) |
| `rl:*` | misc | gestito da `@fastify/rate-limit` | sliding window |

`electionId` è la **stringa numerica** dell'`uint256` on-chain
(`"0"`, `"1"`, ...).

### 6.2 Atomicità email-uniqueness

`user.create()` usa `SET NX` sull'indice email **prima** di scrivere
l'hash utente. Questa è l'unica operazione del repository che ha bisogno
di atomicità:

```js
const reserved = await redis.set(emailKey(email), user.id, "NX");
if (reserved !== "OK") return false;       // email già presa
await redis.hset(userKey(user.id), {...});  // safe a questo punto
```

Se il processo crashasse fra le due chiamate, lo stato sarebbe
"orfano" (email prenotata, hash mancante). L'utente non potrebbe
registrarsi con quella email finché un admin non la libera. Per la fase
attuale è un compromesso accettabile; un upgrade è eseguire le due
scritture in un `MULTI`/`EXEC` con un Lua script.

### 6.3 Election: list + JSON

Le elections sono salvate come JSON (non hash Redis) perché le opzioni
sono un array e tenere tutto compatto è più semplice del modellare hash
+ liste. Il listing usa `SMEMBERS election:list` + `pipeline.get` per
evitare N round-trip.

### 6.4 Vote lock (advisory)

```js
acquireLock: async (electionId, userId, ttlSeconds = 30) => {
  const res = await redis.set(
    `lock:vote:${electionId}:${userId}`,
    "1",
    "EX", ttlSeconds, "NX"
  );
  return res === "OK";
};
```

TTL 30 s = upper bound prudente sul tempo di inclusione di una tx in un
blocco + scrittura Redis. Se il backend crashasse durante un voto, il
lock si auto-libera. Il valore non è un nonce-token (non serve la
versione safe del lock distribuito tipo Redlock) perché:

1. Abbiamo un **secondo livello** di sicurezza (check off-chain) e un
   **terzo livello** (check on-chain): il lock è solo un'ottimizzazione
   contro race condition strette.
2. Il caso d'uso è single-tenant, non c'è failover multi-DC.

---

## 7. Layer Service (logica di business)

I service sono factory che ricevono i loro collaboratori (repo, chain,
config) per **dependency injection esplicita**. Niente importazioni
dirette da Redis o ethers nei service: tutto passa dai parametri di
costruzione, così sono testabili senza mock magici.

### 7.1 `authService`

Quattro metodi:

- `register({email, password})` — bcrypt(10), `users.create()`, ritorna
  `publicUser` (mai il `passwordHash`).
- `login({email, password})` — fetch + `bcrypt.compare`. Il messaggio di
  errore è **identico** per "email non esiste" e "password sbagliata"
  (`INVALID_CREDENTIALS`) per non rivelare quali email sono registrate.
- `getById(id)`.
- `ensureAdmin({email, password})` — idempotente, usato dal seed.

### 7.2 `electionService`

- `create(input, createdBy)` — verifica time window, costruisce metadata
  off-chain, calcola `metadataHash` canonico, chiama `chain.createElection`,
  estrae `electionId` dall'evento, persiste in Redis. **Pre-check**
  ridondante (start nel futuro, end > start) prima di chiamare la chain
  per restituire 400 senza pagare gas inutilmente.
- `open(id)` — apertura anticipata. Pre-check off-chain, poi
  `chain.openElection`, poi update Redis con `startTime = now` e
  `openedTxHash`/`openedBlockNumber`.
- `close(id)` — analogo per chiusura manuale.
- `list()`, `getById()` — lettura dal repo, mapping a oggetto pubblico
  con `status` derivato localmente come fallback.
- `getStatus(id)` — **legge dalla chain** e cross-checka il
  `metadataHash`. Se il match fallisce, l'admin sa che qualcuno ha
  alterato Redis (`metadataMatches: false`). Se l'RPC è giù, fallback al
  derivato locale + `chainError` nel payload.

### 7.3 `voteService`

Il cuore del backend. Vedi §10 per il flusso completo.

```js
function createVoteService({ elections, votes, chain, salt }) {
  return {
    castVote(user, electionId, input) { /* ... */ },
    getMyStatus(user, electionId) { /* ... */ },
  };
}
```

Note di design:

- Riceve il `salt` come parametro (non lo legge dalla config) — più
  testabile, e nel codice di produzione è iniettato da `app.js` da
  `config.VOTER_HASH_SALT`.
- Ricalcola sempre `voterCommitmentHash` invece di leggerlo da Redis,
  così anche se un attaccante manomettesse Redis non riuscirebbe a
  cambiare l'hash sotto cui finirebbe il suo voto on-chain.
- Tutti i path che potrebbero mantenere il lock attivo finiscono in
  `try { ... } finally { releaseLock }`.

---

## 8. Layer Routes (HTTP)

Ogni file `*.routes.js` esporta un **plugin async** Fastify. Le route
sono molto sottili: validazione + chiamata al service.

### 8.1 Validazione Zod

Non usiamo gli schemi JSON-Schema di Fastify per `body`/`params`:
preferiamo Zod perché ci dà validazione **e** narrowing dei valori
(coerce, `default`, `refine`). Lo facciamo manualmente nel handler:

```js
app.post("/auth/register", async (req, reply) => {
  const body = registerSchema.parse(req.body);   // throw ZodError -> 400
  const user = await authService.register(body);
  return reply.code(201).send({ user });
});
```

L'`errorHandler` mappa `ZodError` in `400 VALIDATION_ERROR` con la lista
di `issues`. Il client riceve quale campo è invalido e perché.

### 8.2 preHandler per autenticazione e ruoli

Per le route che richiedono auth uniforme, registriamo l'`addHook` a
livello di plugin:

```js
// admin.routes.js
app.addHook("preHandler", app.authenticate);
app.addHook("preHandler", app.requireAdmin);
// ...tutte le route definite dopo richiedono admin auth
```

Il fatto che i route file siano plugin **non** registrati con `fp` crea
un **encapsulation context**: gli `addHook` valgono solo al loro
interno. Quindi `votes.routes.js` aggiunge `authenticate` ma non
`requireAdmin`, mentre `elections.routes.js` non aggiunge nulla (route
pubbliche).

### 8.3 Rate limit per route

```js
app.post("/auth/login", {
  config: {
    rateLimit: {
      max: app.config.RATE_LIMIT_LOGIN_MAX,
      timeWindow: app.config.RATE_LIMIT_LOGIN_WINDOW,
      keyGenerator: (req) => `login:${req.ip}:${(req.body?.email||"").toLowerCase()}`,
    },
  },
}, handler);
```

Funziona perché abbiamo registrato `@fastify/rate-limit` con
`global: false`: la presenza di `config.rateLimit` opta-in la route nella
politica.

---

## 9. Schema di hashing

Il backend produce **tre hash** distinti, con scopi diversi.

### 9.1 `metadataHash` — integrità delle election

```js
metadataHash = keccak256(canonicalJson({title, description, options,
                                        startTime, endTime}))
```

`canonicalJson` ordina ricorsivamente le chiavi degli oggetti: due
backend in due continenti producono lo **stesso hash** dato lo stesso
oggetto. Questo permette al frontend (o a un auditor esterno) di:

1. Scaricare il documento metadata dal backend (`GET /elections/:id`).
2. Ricalcolare `keccak256(canonicalJson(...))`.
3. Confrontare con `getElection(id).metadataHash` letto **direttamente
   dalla chain**.

Se non combaciano → il backend ha alterato il documento dopo la
creazione on-chain. `electionService.getStatus` espone già questo
confronto come `metadataMatches: boolean`.

### 9.2 `voterCommitmentHash` — chiave di unicità del votante

```js
voterCommitmentHash = keccak256(`${userId}|${electionId}|${VOTER_HASH_SALT}`)
```

Proprietà:

- **Deterministico** dato `(userId, electionId, salt)`: il backend lo
  ricalcola in qualsiasi momento per `hasUserVoted`, senza salvarlo.
- **Inversione resa difficile dal salt**: senza `VOTER_HASH_SALT` un
  osservatore on-chain potrebbe brute-forzare lo spazio degli userId
  (specie se ULID brevi); con un salt da ≥ 32 byte casuali la
  preimage è infattibile.
- **Stesso commitment per voti multipli dello stesso utente** sulla
  stessa election → il contratto rifiuta on-chain (`AlreadyVoted`).
- **Commitment diversi su election diverse** → uno stesso utente può
  votare su election diverse senza che on-chain si possa correlare
  (a meno di conoscere il salt).

> **Importante**: il salt è il segreto chiave del sistema. Va trattato
> come una master key, ruotato solo con un piano (ruotare il salt
> invalida tutti i commitment passati lato backend; on-chain restano
> validi).

### 9.3 `voteHash` — opaco della scelta

```js
nonce = randomBytes(32)
voteHash = keccak256(`${electionId}|${selectedOption}|${nonce}`)
```

Senza il `nonce`, lo spazio possibile sarebbe `electionCount × optionCount`,
banalmente brute-forzabile. Con un nonce da 32 byte, `voteHash` è
essenzialmente uniforme su `2^256` e non rivela nulla sulla scelta.

Il backend salva `(selectedOption, nonce)` insieme al `voteHash`: in
qualsiasi momento può **dimostrare** che quel `voteHash` corrisponde a
una scelta specifica (utile per audit dopo la chiusura, o per
contestazioni).

---

## 10. Flusso del voto in dettaglio

```
Client (frontend)
  │ POST /elections/:id/vote   { selectedOption: 1 }
  │ Authorization: Bearer <jwt>
  ▼
[Fastify route preHandler]
  ├─ helmet headers
  ├─ rate-limit ▸ key = "vote:{userId}"        ─ 429 RATE_LIMITED
  ├─ authenticate ▸ jwtVerify()                ─ 401 UNAUTHORIZED
  └─ role check (voter/admin)                  ─ 403 FORBIDDEN
       │
       ▼
[Route handler]
  ├─ params parse: electionIdParam.parse(req.params)   ─ 400 VALIDATION_ERROR
  └─ body  parse: castVoteSchema.parse(req.body)       ─ 400 VALIDATION_ERROR
       │
       ▼
[voteService.castVote(user, electionId, input)]
  │
  │ 1) elections.findById(electionId)                  ─ 404 ELECTION_NOT_FOUND
  │ 2) sanity check su selectedOption < options.length ─ 400 INVALID_OPTION
  │ 3) votes.acquireLock(electionId, userId, 30)       ─ 409 VOTE_IN_PROGRESS
  │     try {
  │       4) votes.findByUser(...)                     ─ 409 ALREADY_VOTED (off-chain)
  │       5) commitment = keccak256(uid|eid|salt)
  │       6) chain.hasUserVoted(eid, commitment)       ─ 409 ALREADY_VOTED (on-chain)
  │       7) chain.getStatus(eid) == ACTIVE            ─ 409 ELECTION_NOT_ACTIVE
  │       8) nonce = randomBytes(32)
  │          voteHash = keccak256(eid|sel|nonce)
  │       9) chain.castVote(eid, commitment, voteHash)
  │           └─ tx.wait() restituisce txHash + blockNumber
  │      10) votes.save(eid, uid, {voteHash, commitment, sel, nonce, txHash, ...})
  │     } finally { votes.releaseLock(...) }
  │
  ▼
[Response]
  201 { vote: { electionId, txHash, blockNumber, voteHash, voterCommitmentHash, castAt } }
```

Dettagli importanti:

- Lo step (3) è la **prima** scrittura, prima di ogni cosa che potrebbe
  rallentare. Se due richieste concorrenti dello stesso utente arrivano
  entrambe (es. doppio click), una vince il `SET NX` e l'altra prende
  `409 VOTE_IN_PROGRESS`.
- Lo step (6) è una difesa contro un attaccante che riesca a wipare
  Redis (es. `FLUSHDB` malevolo) e a far crollare la difesa (4).
  L'on-chain è la verità.
- Lo step (7) è una difesa contro race-condition: la election potrebbe
  essere stata appena chiusa via `closeElection` mentre noi avevamo già
  passato i check off-chain.
- La `tx.wait()` (9) può durare **secondi** su una mainnet — il timeout
  HTTP del frontend va dimensionato di conseguenza. Su Hardhat è
  istantaneo. Per produzione si può ritornare `202 Accepted` con un
  `jobId` e completare async, ma in fase attuale la sincronia è più
  semplice da capire e testare.
- Il `nonce` è generato **dopo** tutti i check pesanti per non bruciare
  entropia in caso di rifiuto.

---

## 11. Anti-doppio voto: tre livelli di difesa

| Livello | Dove | Cosa protegge | Come si bypassa |
| --- | --- | --- | --- |
| **L1 — Lock Redis** (`lock:vote:eid:uid`, NX EX 30) | `voteService` step 3 | Race-condition strette (doppio click, due tab) | Solo se Redis e backend collaborano (non bypassabile da utente) |
| **L2 — Off-chain check** su `vote:eid:uid` | `voteService` step 4 | Doppio voto post-fatto, anche dopo che il lock è scaduto | Se Redis viene wipato fra il primo voto e il secondo |
| **L3 — On-chain `hasUserVoted`** | `voteService` step 6 | Tutto il resto, incluse manomissioni di Redis | Solo se la chain stessa fosse compromessa |

Il test `prevents double vote even if Redis state is wiped (on-chain
check)` simula esattamente lo scenario: vota → `redis.del('vote:0:uid')`
→ riprova a votare → 409 `ALREADY_VOTED` perché L3 ferma comunque la tx.

---

## 12. Sicurezza (defense in depth)

### 12.1 Trasporto e header

- Helmet con default sani: `X-Content-Type-Options: nosniff`,
  `X-DNS-Prefetch-Control`, `Referrer-Policy`,
  `Strict-Transport-Security` (in HTTPS). CSP off perché siamo
  un'API JSON.
- `trustProxy: true` su Fastify: l'IP usato dai rate-limit è quello del
  client, non del reverse proxy. **Importante**: in produzione assicurarsi
  che la rete davanti sia trusted, altrimenti `X-Forwarded-For` è
  spoofabile.

### 12.2 Auth

- Password: bcrypt(10), nessuno store del clear-text. Il payload del JWT
  non contiene la password. La risposta API non include mai
  `passwordHash`.
- JWT secret ≥ 16 char (validato da Zod), in produzione ≥ 32 random.
- TTL del token configurabile (`JWT_EXPIRES_IN`).
- Errore di login generico (`INVALID_CREDENTIALS`) per non distinguere
  email-non-esiste vs password-sbagliata.
- Niente refresh token in questa fase: l'utente rifa login a scadenza.

### 12.3 Authorization

- Ruoli `admin` e `voter`. Le route `/admin/*` montano `requireAdmin` a
  livello di plugin (impossibile dimenticarsene per route nuova del
  modulo).
- L'azione di voto richiede un ruolo (`voter` o `admin`) ed è
  esplicitamente verificata nell'handler.

### 12.4 Input

- Validazione Zod su tutti i body e i path params, errori strutturati.
- `selectedOption` ha doppia validazione: bound stretto da Zod
  (`max(31)`) come sanity guard, e bound semantico nel service contro
  `options.length` reale.

### 12.5 Rate limit

- Login per `ip+email` (vedi §5.5).
- Vote per `userId` (l'attaccante deve già essere autenticato per
  arrivarci).
- Backend Redis condiviso: **funziona anche con N istanze del backend
  dietro un load balancer** (i contatori sono globali).

### 12.6 Segreti

- Niente segreti nel codice. `PRIVATE_KEY`, `JWT_SECRET`,
  `VOTER_HASH_SALT` esclusivamente da `.env`.
- `.env` in `.gitignore`. `.env.example` contiene placeholder.
- Pino redact su `authorization`, `cookie`, `req.body.password`,
  `req.body.passwordHash`.

### 12.7 Privacy on-chain

Il backend non scrive **mai** dati personali on-chain. Il contratto
vede solo `bytes32` opachi. La risoluzione `commitment → utente` e
`voteHash → scelta` vive solo nel backend. Vedi §9 per come gli hash
sono costruiti per non essere invertibili.

### 12.8 Privacy off-chain

`vote:{eid}:{uid}` contiene la scelta in chiaro (decisione presa con
l'utente in fase 0). Conseguenze:

- Chiunque legga Redis può sapere **chi ha votato cosa**.
- Mitigazione operativa: cifrare il volume Redis, restringere l'accesso
  di rete, audit log.
- Mitigazione applicativa (futura): cifrare `selectedOption` con una
  chiave admin (busta sigillata aprita solo a chiusura), o non salvarla
  affatto e ricostruirla solo da `voteHash + nonce` con ricerca brute
  sull'option set.

---

## 13. Logging e redaction

Pino è configurato in `app.js`:

```js
logger: {
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.passwordHash',
      'res.headers["set-cookie"]',
    ],
    censor: "[REDACTED]",
  },
}
```

Conseguenze:

- I log mostrano `authorization: "[REDACTED]"`, mai il bearer token.
- I log dei body delle request `register`/`login` hanno `password:
  "[REDACTED]"`.
- I log strutturati (JSON) sono parsabili da Loki/Datadog/ELK senza
  trasformazioni.

In dev/test impostiamo `LOG_LEVEL=silent` nel test helper per non
inquinare l'output dei test.

---

## 14. Gestione errori centralizzata

Il principio è: **i service e i route lanciano errori tipizzati**;
il route handler **non costruisce mai una risposta di errore a mano**.

Catena di traduzione:

```
Service                                     Route                     Client
─────                                       ─────                     ──────
throw notFound("ELECTION_NOT_FOUND",...)  → propaga                → 404 {error:"ELECTION_NOT_FOUND",
                                                                        message:"..."}
throw conflict("ALREADY_VOTED",...)       → propaga                → 409 {...}
input.parse(...) -> ZodError              → propaga                → 400 {error:"VALIDATION_ERROR",
                                                                        issues:[{...}]}
RPC down -> err generico                  → propaga                → 500 INTERNAL_ERROR (loggato)
```

Tutti gli `HttpError` sono creati tramite gli helper in
`utils/errors.js`:

```js
badRequest("INVALID_OPTION", "selectedOption must be in [0, n-1]")
unauthorized("UNAUTHORIZED", "Missing or invalid access token")
forbidden("FORBIDDEN", "Admin role required")
notFound("ELECTION_NOT_FOUND", `Election ${id} not found`)
conflict("ALREADY_VOTED", "You have already voted in this election")
```

**Non** facciamo throw di stringhe o `Error` generici nei service:
arriverebbero come 500 e ingannerebbero il client.

---

## 15. Test e strategia di mocking

### 15.1 Cosa testiamo (e cosa no)

Testiamo **lo stack reale** dell'applicazione (Fastify + plugin + route
+ service + repo) con due seam controllabili:

- **Redis** è sostituito con `ioredis-mock` — un'implementazione
  in-memory **fedele** delle stesse semantiche (`SET NX EX`,
  `pipeline`, `SMEMBERS`, ...).
- **Chain** è sostituita con un mock in-memory che **replica le
  invariant del contratto** (`mockChain.js`): time-driven status,
  `manuallyClosed`, `AlreadyVoted`, `ElectionNotActive`,
  `ElectionAlreadyStarted`. Non testiamo Solidity (è coperto da
  `contracts/test/VotingRegistry.test.js`), testiamo che il backend si
  comporti correttamente quando la chain restituisce questi outcome.

Non testiamo:

- L'integrazione reale con un Hardhat node (è copertura di un test e2e
  che vive a livello superiore, fuori dallo scope di questa fase).
- Il rate limit "vero" (i test alzano i max a 1000 per non interferire).

### 15.2 `buildTestApp.js`

Costruisce un'app fresca per ogni test (`beforeEach`):

```js
const ctx = await buildTestApp();
// ctx.app    -> Fastify app pronta (non in listen)
// ctx.redis  -> ioredis-mock per assertions
// ctx.chain  -> mock in-memory per ispezionare lo stato (.elections, .voted)
// ctx.config -> config statica (no .env richiesto)
// helpers:
ctx.loginAdmin()           // -> {token, user}
ctx.registerVoter(email)   // -> {token, user}
```

L'app non viene messa in `listen`; usiamo `app.inject(...)` di Fastify
che esegue la pipeline HTTP completa **in process**, senza socket. È più
veloce e deterministico.

### 15.3 Coverage attuale

22 test in 3 file, tutti verdi:

| File | Test |
| --- | --- |
| `auth.test.js` | register, duplicate email, validation, login OK, login KO, /auth/me con/senza token, admin seed |
| `elections.test.js` | create admin, blocco non-admin, blocco unauth, validation (options/time), list/read/status pubblico (con `metadataMatches`), open + close lifecycle, 404 |
| `votes.test.js` | happy path, doppio voto via Redis, doppio voto **dopo wipe Redis** (L3), invalid option semantica, invalid option zod, voto su election chiusa, voto senza auth, my-vote-status before/after |

```
Test Files  3 passed (3)
     Tests  22 passed (22)
```

### 15.4 Aggiungere un nuovo test

Pattern:

```js
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildTestApp } from "./helpers/buildTestApp.js";

describe("my feature", () => {
  let ctx;
  beforeEach(async () => { ctx = await buildTestApp(); });
  afterEach(async () => { await ctx.app.close(); });

  it("does X", async () => {
    const { token } = await ctx.registerVoter("x@test.local");
    const res = await ctx.app.inject({
      method: "POST", url: "/...",
      headers: { authorization: `Bearer ${token}` },
      payload: { /* ... */ },
    });
    expect(res.statusCode).toBe(201);
  });
});
```

---

## 16. Threat model e limiti

### 16.1 Cosa difende

| Minaccia | Difesa |
| --- | --- |
| Doppio voto stesso utente | L1 lock + L2 off-chain + L3 on-chain |
| Brute force password | bcrypt + rate-limit login per `ip+email` + messaggio generico |
| Brute force voto | rate-limit per `userId` |
| Token rubato | TTL JWT corto (default 2h); revoca server-side richiede aggiungere blacklist (non in questa fase) |
| Chi ha votato cosa (on-chain) | `voterCommitmentHash` non invertibile (con salt segreto) |
| Cosa è stato votato (on-chain) | `voteHash` con nonce 32 byte → opaco |
| Tampering metadata election | `metadataHash` su chain + `metadataMatches` esposto |
| Crash del backend a metà voto | Lock con TTL 30 s + on-chain è la verità |
| Wipe malevolo di Redis | L3 on-chain ferma comunque doppio voto |
| RPC down al login/lookup | Endpoint pubblici degradano a "local status + chainError"; voto fallisce esplicitamente |
| Chain-id confusion (RPC malevolo) | `JsonRpcProvider({chainId})` esplicito |

### 16.2 Cosa NON difende

| Limite | Mitigazione possibile |
| --- | --- |
| Compromissione del relayer (PRIVATE_KEY) | Multisig come owner del contratto, signing remoto (HSM/KMS) |
| Compromissione di Redis | Cifratura at-rest, ACL, audit log; cifrare `selectedOption` con chiave admin |
| Censura selettiva del relayer | Permettere agli utenti di firmare direttamente la propria tx (richiede wallet lato frontend) |
| Sybil voter | Out of scope: la lista voter è quella registrata; serve KYC esterno per attribuire identità reali |
| Logout server-side immediato | Aggiungere blacklist `jti` su Redis con TTL=exp |
| Replay nonce su rete diversa | Già coperto da `chainId` esplicito + il commitment include `electionId` |
| Bot di registrazione | Aggiungere captcha su `/auth/register` |

### 16.3 Trust model

- **Backend trusted**: vede password (in transito, hashate prima di salvare), vede scelte di voto, conosce il salt.
- **Chain trusted**: per le invariant di unicità voto e per la finestra temporale.
- **Frontend untrusted**: tutte le validazioni di sicurezza sono server-side.
- **Utente untrusted**: nessuna API si fida del client per controlli di autorizzazione.

---

## 17. Estensione del backend

### 17.1 Aggiungere un endpoint admin

1. Aggiungi schema Zod in `src/schemas/...`.
2. Aggiungi metodo nel service (`electionService` o nuovo).
3. Aggiungi route in `src/routes/admin.routes.js` (eredita già i
   preHandler `authenticate` + `requireAdmin`).
4. Aggiungi test in `test/elections.test.js` con `loginAdmin()`.
5. Aggiorna `API.md`.

### 17.2 Aggiungere refresh token / sessioni revocabili

1. Nuova chiave `session:{sessionId}` in Redis con TTL = refresh window.
2. Payload JWT include `sid`. Hook nuovo: `app.authenticateWithSession`
   che dopo `jwtVerify` controlla che `session:{sid}` esista.
3. Endpoint `/auth/logout` → `DEL session:{sid}`.
4. Endpoint `/auth/refresh` → emette nuovo access token se la session è
   ancora viva.

Il codice attuale è già strutturato per ospitare questa modifica
contenendola al solo `auth` plugin + service.

### 17.3 Cambiare il backend di firma (multisig / KMS)

Modificare solo `src/plugins/blockchain.js`. Sostituire `ethers.Wallet`
con un `Signer` custom che parla con AWS KMS / GCP KMS / multisig. Il
resto dell'app non vede la differenza.

### 17.4 Aggiungere un altro storage (Postgres)

Sostituire i tre file in `src/repositories/*` mantenendo la stessa
interfaccia. I service non vedono la differenza. Redis può rimanere per
rate-limit/lock/cache.

---

## 18. Runbook operativo

### 18.1 Health check

`GET /health` → `200 { status: "ok", uptime: <seconds> }`.
Da usare con orchestrator (k8s liveness/readiness).

### 18.2 Startup checklist

1. Redis raggiungibile su `REDIS_URL`.
2. RPC EVM raggiungibile su `RPC_URL` con il `CHAIN_ID` atteso.
3. Saldo del relayer sufficiente per le tx (admin + voti).
4. `CONTRACT_ADDRESS` deployato e di tipo `VotingRegistry`.
5. Owner del contratto = address del relayer (`PRIVATE_KEY`). Verifica:

   ```bash
   cast call $CONTRACT_ADDRESS "owner()(address)" --rpc-url $RPC_URL
   ```

6. Admin seed creato (osservare il log `Admin user is ready`).

### 18.3 Monitoraggio chiave

- **Latency `/elections/:id/vote`**: dipende dal tempo di mining della
  tx. Alert se > 30 s sostenuti.
- **Errori 5xx**: in particolare `Unhandled error` nei log.
- **Saldo del relayer**: tx senza gas falliscono in 500 — alert su
  saldo basso prima.
- **`metadataMatches: false`** in `/elections/:id/status`: alert
  immediato (manomissione metadata).
- **Rate di `409 ALREADY_VOTED`**: spike anomalo = retry malevoli.

### 18.4 Recovery

- **Crash a metà voto** (lock ancora attivo, tx già emessa):
  l'utente vedrà `409 VOTE_IN_PROGRESS` per max 30 s, poi il lock scade
  e al retry sarà `409 ALREADY_VOTED` (L2 o L3). Nessun intervento
  manuale necessario.
- **Redis perso**: gli utenti si re-registreranno. Le elections vanno
  ricostruite **leggendole dalla chain** (eventi `ElectionCreated`,
  `ElectionOpened`, `ElectionClosed`); i metadata originali off-chain
  vanno restaurati da backup. Lo `metadataHash` on-chain certifica
  l'integrità.
- **Chiave relayer compromessa**: `transferOwnership` del contratto
  verso una nuova chiave (richiede ancora la vecchia per firmare).
  Aggiornare `PRIVATE_KEY` nel `.env`.

---

*Fine della documentazione tecnica. Per dettagli operativi al volo
vedi `README.md`; per la firma di ogni endpoint vedi `API.md`.*
