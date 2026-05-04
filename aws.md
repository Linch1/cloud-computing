# Deploy su AWS — architettura "managed minimale"

Questo documento descrive il deployment della piattaforma di voto su AWS
con l'obiettivo di **massimizzare la semplicità operativa** mantenendo
la separazione netta tra frontend, backend e blockchain del setup
locale documentato in [`README.md`](./README.md) e
[`VOTING_FLOW.md`](./VOTING_FLOW.md).

L'architettura usa **tre componenti**, nessuna VPC custom, nessun
Secrets Manager, nessun dominio custom.

---

## TL;DR

| Pezzo                   | Servizio AWS                  | Sostituisce nel locale                     |
| ----------------------- | ----------------------------- | ------------------------------------------ |
| Frontend Next.js 14     | **Amplify Hosting**           | `cd frontend; npm run dev` (porta 3000)    |
| Backend Fastify relayer | **App Runner**                | `cd backend; npm run dev` (porta 3001)     |
| Hardhat node + Redis    | **Lightsail VM 1 GB**         | `npx hardhat node` + `docker run redis`    |

Costo stimato: **~$15–20/mese**.

---

## Perché questi servizi e non altri

### Amplify Hosting (frontend)

Next.js 14 con App Router richiede SSR. Amplify lo supporta nativamente
e include CDN (CloudFront) + TLS gratis + build automatico da GitHub.
L'alternativa "Next.js dentro Fargate" raddoppierebbe i pezzi senza
benefici per questo workload.

### App Runner (backend)

Il backend Fastify è un **processo long-running stateful**: tiene aperta
una connessione persistente al chain (ethers.js wallet) e una a Redis,
gestisce rate-limit per-utente, tiene un lock NX-EX sui voti in volo.

App Runner è la scelta giusta perché:

- gira 24/7 (o con auto-pause), non è "function-style" come Lambda;
- gestisce HTTPS, scaling, deploy da GitHub o ECR, **senza VPC**;
- accetta env-var direttamente nella service config;
- costa ~$5/mese con auto-pause attivo (fa cold-start di ~1 s al primo
  hit dopo inattività; per una demo è invisibile).

L'alternativa "Fargate + ALB + NAT" aggiungerebbe ~$50/mese in
networking puro per zero feature aggiuntive a questo livello di carico.

### Lightsail VM (Hardhat node + Redis)

La piattaforma **deve** parlare con una blockchain EVM. Le opzioni sono:

1. RPC esterno managed (Alchemy, Infura) puntato a Sepolia → richiede
   re-deploy del contratto su una testnet vera, e dipendi da un servizio
   esterno con free tier.
2. **Hardhat node self-hosted su una VM** → la chain è completamente
   sotto il tuo controllo, lo stesso identico setup del locale, nessun
   provider esterno.

Per un progetto Erasmus / demo, la (2) è preferibile: l'esperienza
utente è identica a quella locale e il costo è marginale.

Sulla stessa VM gira anche **Redis**, perché:

- è già il più piccolo box AWS sensato ($5/mese, 1 GB RAM);
- separare Redis su ElastiCache costerebbe ~$12/mese in più senza
  benefici (Redis su un Lightsail single-node, con `appendonly yes` e
  `requirepass`, regge tranquillamente il throughput previsto).

### Cosa NON c'è (e perché)

| Componente            | Perché non serve                                                                 |
| --------------------- | -------------------------------------------------------------------------------- |
| VPC custom            | Tutti i servizi parlano "pubblico-su-pubblico" via TLS / password.               |
| NAT Gateway           | Niente private subnet → niente NAT.                                              |
| Application Load Balancer | App Runner espone già un endpoint HTTPS gestito.                              |
| ECR                   | App Runner builda direttamente da GitHub (`apprunner.yaml`).                     |
| Route 53 + ACM        | Si usano i sottodomini `*.amplifyapp.com` e `*.awsapprunner.com`, TLS incluso.   |
| Secrets Manager       | Le env-var del backend stanno nella service config di App Runner (cifrata a riposo). La `PRIVATE_KEY` qui è il signer #0 di Hardhat — chiave pubblicamente nota, gas finto, nessun valore reale. |
| ElastiCache           | Redis gira sulla Lightsail VM, sufficiente per il throughput previsto.           |

---

## Diagramma

```
                              ┌──────────────────────────────────────┐
                              │              AWS                      │
   Browser                    │                                       │
       │                      │   ┌─────────────────────────┐         │
       │  HTTPS               │   │  Amplify Hosting         │        │
       ├─────────────────────►│   │  Next.js 14 SSR          │        │
       │                      │   │  voting.amplifyapp.com   │        │
       │                      │   └────────────┬────────────┘         │
       │                      │                │  HTTPS /api/*        │
       │                      │                ▼                      │
       │                      │   ┌─────────────────────────┐         │
       │  HTTPS (diretto      │   │  App Runner              │        │
       ├─────────────────────►│   │  Fastify relayer         │        │
       │   per le API)        │   │  backend.awsapprunner.com│        │
       │                      │   └──┬────────────────────┬─┘         │
       │                      │      │ TLS+AUTH           │ JSON-RPC  │
       │                      │      │ :6379              │ :8545     │
       │                      │      ▼                    ▼           │
       │                      │   ┌──────────────────────────────┐    │
       │                      │   │  Lightsail VM 1 GB · $5/mo   │    │
       │                      │   │  ──────────────────────────  │    │
       │                      │   │  • Redis container :6379     │    │
       │                      │   │    (requirepass)             │    │
       │                      │   │  • Hardhat node :8545        │    │
       │                      │   │  • VotingRegistry @          │    │
       │                      │   │    0x5FbDB231...678afecb     │    │
       │                      │   │    (deploy deterministico)   │    │
       │                      │   └──────────────────────────────┘    │
       │                      │                                       │
       │                      └──────────────────────────────────────┘
```

---

## Costo mensile (eu-west-1, traffico bassissimo)

| Voce                              | Config                               | $/mese       |
| --------------------------------- | ------------------------------------ | ------------ |
| Amplify Hosting                   | low traffic, ~1 build/giorno         | $5–10        |
| App Runner (auto-pause)           | 0.5 vCPU / 1 GB                      | ~$5          |
| Lightsail VM                      | 1 GB / 2 vCPU / 40 GB SSD / 2 TB tx  | $5           |
| **Totale**                        |                                      | **~$15–20**  |

App Runner sempre acceso (niente cold-start) porta il totale a ~$35/mese.

---

## Setup della Lightsail VM

### 1. Crea l'istanza

Dalla console Lightsail (eu-west-1):

- Plan: **$5/mo** (1 GB RAM / 2 vCPU / 40 GB SSD / 2 TB transfer)
- OS: **Ubuntu 22.04 LTS**
- Region: la stessa di App Runner per minimizzare la latenza

Una volta creata:

1. Assegna un **Static IP** (gratis se attaccato a una istanza).
2. Apri il **firewall** della Lightsail con queste regole:

   | Application | Protocol | Port | Source              |
   | ----------- | -------- | ---- | ------------------- |
   | SSH         | TCP      | 22   | il tuo IP           |
   | Custom      | TCP      | 8545 | Anywhere (0.0.0.0/0) |
   | Custom      | TCP      | 6379 | Anywhere (0.0.0.0/0) |

   Hardhat è in chiaro ma è una testnet finta (gas e ETH non hanno valore
   reale). Redis è protetto da `requirepass`.

### 2. Provisioning

```bash
ssh ubuntu@<static-ip>

# Docker + git
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose-plugin git
sudo usermod -aG docker $USER
exit  # riapri la sessione SSH per applicare il gruppo

ssh ubuntu@<static-ip>
git clone <url-del-tuo-repo>.git voting
cd voting
```

### 3. `docker-compose.yml` (già presente alla root del repo)

Il file [`docker-compose.yml`](./docker-compose.yml) alla root contiene
i tre servizi: `hardhat`, `deploy` (one-shot) e `redis` con
`requirepass` + `appendonly`.

> Nota: il job `deploy` parte una sola volta a ogni `up` e attende che
> il `hardhat` container abbia finito `npm ci` e che la porta 8545
> risponda. Grazie al fatto che il primo `npx hardhat node` parte
> sempre dal signer #0 con nonce 0, l'indirizzo del contratto è
> **deterministico** e vale sempre `0x5FbDB2315678afecb367f032d93F642f64180aa3`
> (lo stesso del setup locale).

### 4. Avvio

```bash
echo "REDIS_PASSWORD=$(openssl rand -hex 32)" > .env
cat .env  # salvati la password: la userai in App Runner

docker compose up -d
docker compose logs -f hardhat   # verifica che parta e che il deploy stampi l'address
```

Se Hardhat reboot wipe-state ti dà fastidio, configura il container
`hardhat` con `restart: "no"` e tienilo "fisso" — la VM Lightsail non si
riavvia da sola.

---

## Setup di App Runner (backend)

### 1. `apprunner.yaml` (già presente in `backend/`)

Il file [`backend/apprunner.yaml`](./backend/apprunner.yaml) descrive a
App Runner come buildare (`npm ci --omit=dev`) e come avviare
(`node src/server.js`) il backend Fastify.

### 2. Crea il servizio App Runner

Console → App Runner → Create service:

- Source: **GitHub** → seleziona repo + branch `main` + sottocartella
  `backend/`
- Deployment trigger: **Automatic** (deploy a ogni push)
- Build: usa `apprunner.yaml`
- Service settings:
  - vCPU: **0.5**, Memory: **1 GB**
  - Auto scaling: min 1, max 1 (è un singleton stateful)
  - **Auto-pause**: abilitato (configurazione "On-demand")
- Environment variables (plain text, nessun Secrets Manager):

  ```
  PORT=3001
  HOST=0.0.0.0
  NODE_ENV=production
  LOG_LEVEL=info

  CORS_ORIGIN=https://<id>.amplifyapp.com

  REDIS_URL=redis://default:<REDIS_PASSWORD>@<lightsail-static-ip>:6379

  JWT_SECRET=<32+ caratteri random>
  JWT_EXPIRES_IN=2h

  ADMIN_EMAIL=admin@example.com
  ADMIN_PASSWORD=<password forte>

  RPC_URL=http://<lightsail-static-ip>:8545
  CHAIN_ID=31337
  PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  CONTRACT_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3

  VOTER_HASH_SALT=<32+ caratteri random>

  RATE_LIMIT_LOGIN_MAX=5
  RATE_LIMIT_LOGIN_WINDOW=1 minute
  RATE_LIMIT_VOTE_MAX=3
  RATE_LIMIT_VOTE_WINDOW=1 minute
  ```

  Genera i due random a 32 byte con:

  ```powershell
  -join ((48..57) + (97..122) + (65..90) | Get-Random -Count 48 | ForEach-Object {[char]$_})
  ```

### 3. Healthcheck

App Runner pinga `GET /` di default. Se il backend espone solo
`/elections` e `/auth`, configura il path `/elections` (è pubblico, non
richiede JWT) come healthcheck nella service config.

---

## Setup di Amplify Hosting (frontend)

### 1. Crea l'app

Console → Amplify → Host web app → GitHub → seleziona repo + branch
`main` + sottocartella `frontend/`.

Amplify rileva automaticamente Next.js 14 con App Router.

### 2. Environment variables

Solo una:

```
NEXT_PUBLIC_API_URL=https://<id>.awsapprunner.com
```

### 3. Aggiorna CORS sul backend

Una volta che Amplify ti dà l'URL `https://<id>.amplifyapp.com`,
aggiorna `CORS_ORIGIN` nelle env-var di App Runner e fai redeploy del
servizio.

---

## Trade-off da accettare

| Trade-off                                  | Impatto                                                                               | Mitigazione                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Stato della chain in RAM                   | Riavviare la VM (o il container `hardhat`) cancella tutto: utenti, elezioni, voti.    | Non riavviare. Lightsail non riavvia da solo. Eventualmente usa `restart: "no"`.     |
| Hardhat RPC senza autenticazione           | Chiunque conosca l'IP può fare query/tx sulla testnet.                                 | È una testnet con valore zero. Eventualmente whitelist dell'IP egress di App Runner. |
| `PRIVATE_KEY` in plaintext nelle env-var   | Visibile a chiunque abbia accesso alla console App Runner.                            | È la chiave pubblica di Hardhat #0. Non c'è nulla da rubare.                          |
| Single-AZ, single-VM                       | Se la Lightsail cade, sia chain che Redis spariscono finché non riparte.              | Snapshot settimanale Lightsail (~$1/mese) per ripartire da zero in pochi minuti.     |
| Redis senza TLS                            | La password viaggia in chiaro tra App Runner e la VM.                                  | Per il livello di criticità della demo è ok. Eventualmente `stunnel` davanti a Redis. |
| App Runner cold-start con auto-pause       | Primo hit dopo inattività ~1–2 s.                                                     | Disabilita auto-pause se serve UX "calda" (~$25/mese in più).                        |

---

## Smoke test post-deploy

Stesso flusso del `README.md` locale, ma su URL pubblici:

1. Apri `https://<id>.amplifyapp.com/login`.
2. Login con `admin@example.com` + la password che hai messo in
   `ADMIN_PASSWORD`.
3. Vai su `/admin/elections/new`, crea un'elezione con due opzioni e
   finestra `now+1m / now+30m`.
4. Click su **Open now**. La transazione passa da App Runner alla VM
   Lightsail e torna mined.
5. Apri una sessione anonima, registra un voter, vota, controlla la
   ricevuta (`txHash`, `voteHash`, `voterCommitmentHash`).
6. Ricarica la pagina: il form di voto sparisce perché il backend
   trova la ricevuta in Redis e la verifica con
   `hasUserVoted(electionId, commitment)` sul Hardhat node.

Se i passi 4–5 falliscono con `OwnableUnauthorizedAccount`, hai un
mismatch tra `PRIVATE_KEY` di App Runner e `owner` del contratto: la
soluzione è ridepoloyare `VotingRegistry` con `INITIAL_OWNER` uguale
all'address derivato dalla `PRIVATE_KEY` corrente, oppure tenere il
default (signer #0).

---

## Quando passare a una architettura "vera"

Indicatori che il setup attuale non basta più:

- **Più di un admin che crea elezioni in parallelo** → serve più di un
  task App Runner, e quindi un coordinamento che oggi non c'è (il lock
  Redis copre il caso, ma stai stressando un singolo box).
- **Voti che devono sopravvivere a riavvii della chain** → muoviti su
  Sepolia o un'altra testnet pubblica.
- **Vincoli di privacy/compliance** → serve una vera VPC, Secrets
  Manager, audit log, multi-AZ.
- **Traffico > qualche req/s** → il Hardhat node è single-threaded, va
  sostituito.

In quel caso si torna all'architettura "full multi-tier" con Fargate +
ALB + ElastiCache + NAT + Secrets Manager + Sepolia, costo ~$95/mese e
HA pieno.
