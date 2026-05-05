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

| Pezzo                   | Servizio AWS                          | Sostituisce nel locale                     |
| ----------------------- | ------------------------------------- | ------------------------------------------ |
| Frontend Next.js 14     | **Amplify Hosting**                   | `cd frontend; npm run dev` (porta 3000)    |
| Backend Fastify relayer | **ECS Express Mode** (+ **ECR**)      | `cd backend; npm run dev` (porta 3001)     |
| Hardhat node + Redis    | **Lightsail VM 1 GB**                 | `npx hardhat node` + `docker run redis`    |

Costo stimato: **~$35–45/mese** (l'ALB di ECS Express è il pezzo più costoso, ~$16–17/mese fissi anche a traffico zero).

> **Nota storica.** Una versione precedente di questo documento usava
> **App Runner** per il backend, ma dal 30 aprile 2026 AWS non accetta
> più nuovi clienti su quel servizio e indica **ECS Express Mode**
> come successore ufficiale. La scelta architetturale è equivalente
> (un container managed con HTTPS automatico), ma il costo minimo è
> più alto perché ECS Express ti dà un ALB "vero".

---

## Perché questi servizi e non altri

### Amplify Hosting (frontend)

Next.js 14 con App Router richiede SSR. Amplify lo supporta nativamente
e include CDN (CloudFront) + TLS gratis + build automatico da GitHub.
L'alternativa "Next.js dentro Fargate" raddoppierebbe i pezzi senza
benefici per questo workload.

### ECS Express Mode (backend)

Il backend Fastify è un **processo long-running stateful**: tiene aperta
una connessione persistente al chain (ethers.js wallet) e una a Redis,
gestisce rate-limit per-utente, tiene un lock NX-EX sui voti in volo.

ECS Express Mode (rilasciato a novembre 2025) è la scelta giusta perché:

- Gira su Fargate, è long-running (non function-style come Lambda).
- Dato un container in **ECR**, AWS provvisiona automaticamente cluster
  Fargate, task definition, **Application Load Balancer condiviso con
  HTTPS**, certificato **ACM**, security group, log group, alarm.
- Espone un **dominio AWS-provided** già con TLS valido (niente Route 53
  custom da configurare).
- Accetta env-var direttamente nel form della service config (nessun
  bisogno di Secrets Manager per una demo).
- È il successore ufficiale di App Runner (che dal 30 aprile 2026 non
  accetta più nuovi clienti).

L'alternativa "ECS classico" richiederebbe di scrivere a mano VPC, ALB,
target group, task definition, scaling policy — Express Mode lo fa per
te. L'alternativa "Fargate + ALB + NAT" è esattamente quello che
Express Mode genera, solo manualmente.

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

### Cosa NON ti gestisci a mano (e perché)

| Componente                | Chi se ne occupa                                                            |
| ------------------------- | --------------------------------------------------------------------------- |
| VPC + subnet              | ECS Express Mode ne crea una di default ed è invisibile per te.             |
| Application Load Balancer | ECS Express Mode lo crea e lo condivide con altri tuoi servizi Express (fino a 25). |
| Certificato TLS / ACM     | Auto-emesso e auto-rinnovato da ECS Express.                                |
| Route 53 custom           | Non serve: ECS Express fornisce un dominio `*.<region>.on.aws`.             |
| Secrets Manager           | Le env-var stanno nella service config di ECS Express (cifrate a riposo). La `PRIVATE_KEY` qui è il signer #0 di Hardhat — chiave pubblicamente nota, gas finto, nessun valore reale. |
| ElastiCache               | Redis gira sulla Lightsail VM, sufficiente per il throughput previsto.       |
| **ECR**                   | **Serve**: ECS Express richiede l'immagine in un registry. La pushiamo noi. |

---

## Diagramma

```
                              ┌─────────────────────────────────────────────┐
                              │                  AWS                         │
   Browser                    │                                              │
       │                      │   ┌─────────────────────────┐                │
       │  HTTPS               │   │  Amplify Hosting         │               │
       ├─────────────────────►│   │  Next.js 14 SSR          │               │
       │                      │   │  *.amplifyapp.com        │               │
       │                      │   └────────────┬────────────┘                │
       │                      │                │  HTTPS /api/*               │
       │                      │                ▼                             │
       │                      │   ┌──────────────────────────────────┐       │
       │  HTTPS (diretto      │   │  ECS Express Mode                 │      │
       ├─────────────────────►│   │  ────────────────                 │      │
       │   per le API)        │   │  ALB managed (HTTPS, ACM)         │      │
       │                      │   │   │                                │     │
       │                      │   │   └─► Fargate task                 │     │
       │                      │   │        Fastify relayer             │     │
       │                      │   │        (image dall'ECR)            │     │
       │                      │   │  *.<region>.on.aws                 │     │
       │                      │   └──┬────────────────────┬─┘                │
       │                      │      │ TLS+AUTH           │ JSON-RPC         │
       │                      │      │ :6379              │ :8545            │
       │                      │      ▼                    ▼                  │
       │                      │   ┌──────────────────────────────┐           │
       │                      │   │  Lightsail VM 1 GB · $5/mo   │           │
       │                      │   │  ──────────────────────────  │           │
       │                      │   │  • Redis container :6379     │           │
       │                      │   │    (requirepass)             │           │
       │                      │   │  • Hardhat node :8545        │           │
       │                      │   │  • VotingRegistry @          │           │
       │                      │   │    0x5FbDB231...678afecb     │           │
       │                      │   │    (deploy deterministico)   │           │
       │                      │   └──────────────────────────────┘           │
       │                      │                                              │
       │                      │   ┌──────────────────────────────┐           │
       │                      │   │  ECR (Elastic Container       │          │
       │                      │   │  Registry)                    │          │
       │                      │   │   voting-backend:latest       │          │
       │                      │   └──────────────────────────────┘           │
       │                      └─────────────────────────────────────────────┘
```

---

## Costo mensile (us-east-2, traffico bassissimo)

| Voce                              | Config                                    | $/mese       |
| --------------------------------- | ----------------------------------------- | ------------ |
| Amplify Hosting                   | low traffic, ~1 build/giorno              | $5–10        |
| ECS Express — Fargate task        | 0.25 vCPU / 0.5 GB, sempre acceso          | ~$11         |
| ECS Express — ALB (condiviso)     | base hourly + LCU minime                  | ~$16–17      |
| ECR                               | <500 MB nel free tier                     | $0           |
| CloudWatch Logs                   | minimi                                    | $1           |
| Lightsail VM                      | 1 GB / 2 vCPU / 40 GB SSD / 2 TB tx       | $5           |
| **Totale**                        |                                           | **~$38–45**  |

> Il pezzo più costoso è l'**ALB**: anche a traffico zero il base price
> orario è ~$16/mese. Se ti aspetti di lanciare anche altri micro-servizi
> (es. un secondo backend, una API di stats) puoi metterli tutti su ECS
> Express e quell'ALB viene condiviso, abbattendo il costo per servizio.

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

## Setup del backend (ECR + ECS Express Mode)

### 1. `Dockerfile` (già presente in `backend/`)

Il file [`backend/Dockerfile`](./backend/Dockerfile) buildda l'immagine
di runtime: `node:20-alpine`, copia `package*.json` + `src/`, fa
`npm ci --omit=dev` e lancia `node src/server.js` come utente non-root.
Il `.dockerignore` accanto esclude `node_modules/`, `.env` e i file di
test dal contesto di build.

### 2. Crea il repository ECR

```powershell
aws ecr create-repository `
  --repository-name voting-backend `
  --region us-east-2

# nota nel JSON il campo "repositoryUri", es:
#   123456789012.dkr.ecr.us-east-2.amazonaws.com/voting-backend
```

(Se preferisci la console: ECR → Private registry → Create repository
→ nome `voting-backend`, mantieni il resto sui default.)

### 3. Build & push dell'immagine

Dalla root del progetto in PowerShell (serve Docker Desktop avviato):

```powershell
$ACCOUNT = "<aws-account-id>"      # 12 cifre, lo trovi in alto a destra in console
$REGION  = "us-east-2"
$REPO    = "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/voting-backend"

# 1. login docker -> ECR
aws ecr get-login-password --region $REGION |
  docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

# 2. build (linux/amd64 per Fargate, anche se sei su un Mac M1/M2/M3)
$GIT_SHA    = (git rev-parse --short HEAD)
$BUILD_TIME = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
docker build --platform=linux/amd64 `
  --build-arg GIT_SHA=$GIT_SHA `
  --build-arg BUILD_TIME=$BUILD_TIME `
  -t voting-backend:latest backend\

# 3. tag + push
docker tag voting-backend:latest "${REPO}:latest"
docker push "${REPO}:latest"
```

A push completato, in console ECR vedrai l'immagine taggata `latest`.

### 4. Genera i due segreti random per le env-var

```powershell
function New-RandomString { -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | %{[char]$_}) }
"JWT_SECRET=$(New-RandomString)"
"VOTER_HASH_SALT=$(New-RandomString)"
```

### 5. Crea il servizio ECS Express Mode

Console → **Amazon ECS** → *Express services* → **Create**:

- **Container image URI**: `<ACCOUNT>.dkr.ecr.us-east-2.amazonaws.com/voting-backend:latest`
- **Service name**: `voting-backend`
- **Container port**: `3001`
- **Compute**: 0.25 vCPU / 0.5 GB (il minimo possibile, sufficiente per Fastify)
- **IAM roles**:
  - *Task execution role*: lascia che ECS lo crei automaticamente (servirà a tirare l'immagine dall'ECR e a scrivere i log)
  - *Infrastructure role*: lascia che ECS lo crei automaticamente (gestisce ALB / target group / SG)
- **Environment variables**:

  ```
  PORT                    = 3001
  HOST                    = 0.0.0.0
  NODE_ENV                = production
  LOG_LEVEL               = info
  CORS_ORIGIN             = http://localhost:3000        (placeholder, lo aggiorniamo nella Fase 5)
  REDIS_URL               = redis://default:<REDIS_PASSWORD>@<LIGHTSAIL_IP>:6379
  JWT_SECRET              = <generato sopra>
  JWT_EXPIRES_IN          = 2h
  ADMIN_EMAIL             = admin@example.com
  ADMIN_PASSWORD          = <una password forte>
  RPC_URL                 = http://<LIGHTSAIL_IP>:8545
  CHAIN_ID                = 31337
  PRIVATE_KEY             = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  CONTRACT_ADDRESS        = 0x5FbDB2315678afecb367f032d93F642f64180aa3
  VOTER_HASH_SALT         = <generato sopra>
  RATE_LIMIT_LOGIN_MAX    = 5
  RATE_LIMIT_LOGIN_WINDOW = 1 minute
  RATE_LIMIT_VOTE_MAX     = 3
  RATE_LIMIT_VOTE_WINDOW  = 1 minute
  ```

- **Health check path**: `/elections` (è pubblico, restituisce 200)
- **Auto scaling**: lascia il default (min 1, max varia in base al
  traffico). Per un singleton stateful puoi forzare *min=1, max=1*.

Click **Create**. ECS Express genera in background:

- ECS cluster (Fargate-based)
- Task definition + service
- ALB nuovo (se è il primo servizio Express in regione) o riusa quello
  esistente
- Target group + listener HTTPS :443 con cert ACM
- Security group, log group CloudWatch, alarm di base
- DNS record sul dominio `*.<region>.on.aws`

Tempo tipico: ~5–8 min. Quando lo stato del servizio è *Running*, copia
il **Service endpoint** (qualcosa tipo
`https://voting-backend.abcd1234.us-east-2.on.aws`) — lo chiameremo
`<BACKEND_URL>`.

### 6. Smoke test

```powershell
curl <BACKEND_URL>/elections
# atteso: {"elections":[]}, status 200

curl <BACKEND_URL>/build
# atteso: {"status":"ok","gitSha":"a1b2c3d","buildTime":"2026-05-05T19:12:34Z","node":"v20.x.x"}
```

Il campo `gitSha` / `buildTime` devono combaciare con l'ultimo
`docker build` (+ push) fatto dal tuo laptop. Se non combaciano dopo un
`force-new-deployment`, ECS sta ancora servendo un task vecchio.

Se restituisce 502 o connection reset, controlla nei log CloudWatch
della task se il backend è fallito a parsare le env-var (`zod` urla
forte se manca qualcosa o se un valore non è valido).

### 7. Redeploy quando cambi codice

```powershell
$GIT_SHA    = (git rev-parse --short HEAD)
$BUILD_TIME = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
docker build --platform=linux/amd64 `
  --build-arg GIT_SHA=$GIT_SHA `
  --build-arg BUILD_TIME=$BUILD_TIME `
  -t voting-backend:latest backend\
docker tag voting-backend:latest "${REPO}:latest"
docker push "${REPO}:latest"

# forza la rolling update del servizio (riprende l'immagine `latest`)
aws ecs update-service `
  --cluster <express-cluster-arn> `
  --service voting-backend `
  --force-new-deployment `
  --region us-east-2
```

(L'ARN del cluster è visibile nella console ECS, sezione *Clusters*.)
In alternativa, AWS ha rilasciato una **GitHub Action ufficiale** per
Express Mode che fa build + push + redeploy a ogni push, ma per ora ce
la cavi a mano.

---

## Setup di Amplify Hosting (frontend)

### 1. Crea l'app

Console → Amplify → Host web app → GitHub → seleziona repo + branch
`main` + sottocartella `frontend/`.

Amplify rileva automaticamente Next.js 14 con App Router.

### 2. Environment variables

Solo una:

```
NEXT_PUBLIC_API_URL=<BACKEND_URL>     # es. https://voting-backend.abcd1234.us-east-2.on.aws
```

### 3. Aggiorna CORS sul backend

Una volta che Amplify ti dà l'URL `https://<id>.amplifyapp.com`,
aggiorna `CORS_ORIGIN` nelle env-var del servizio ECS Express
(*ECS console → Express service → Configuration → Edit → Environment
variables*) e fai *Update service* per ridepoloyare il task.

---

## Trade-off da accettare

| Trade-off                                       | Impatto                                                                            | Mitigazione                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Stato della chain in RAM                        | Riavviare la VM (o il container `hardhat`) cancella tutto: utenti, elezioni, voti. | Non riavviare. Lightsail non riavvia da solo. Eventualmente `restart: "no"`. |
| Hardhat RPC senza autenticazione                | Chiunque conosca l'IP può fare query/tx sulla testnet.                              | È una testnet con valore zero.                                                |
| `PRIVATE_KEY` in plaintext nelle env-var di ECS | Visibile a chiunque abbia accesso alla console ECS.                                | È la chiave pubblica di Hardhat #0. Non c'è nulla da rubare.                  |
| Single-AZ, single-VM (Lightsail)                | Se la Lightsail cade, sia chain che Redis spariscono.                               | Snapshot settimanale Lightsail (~$1/mese).                                   |
| Redis senza TLS                                 | La password viaggia in chiaro tra ECS Express e la VM.                              | Per la demo è ok. Eventualmente `stunnel` davanti a Redis.                    |
| Costo fisso dell'ALB                            | ~$16/mese anche a traffico zero.                                                    | Inevitabile su ECS Express con 1 solo servizio. Se ne aggiungi altri, l'ALB si condivide. |
| Build & push manuale dell'immagine               | A ogni cambio di codice del backend devi rifare `docker build && docker push`.     | Configurare la GitHub Action ufficiale di ECS Express Mode (OIDC).            |

---

## Smoke test post-deploy

Stesso flusso del `README.md` locale, ma su URL pubblici:

1. Apri `https://<id>.amplifyapp.com/login`.
2. Login con `admin@example.com` + la password che hai messo in
   `ADMIN_PASSWORD`.
3. Vai su `/admin/elections/new`, crea un'elezione con due opzioni e
   finestra `now+1m / now+30m`.
4. Click su **Open now**. La transazione passa dal task Fargate (ECS
   Express) alla VM Lightsail e torna mined.
5. Apri una sessione anonima, registra un voter, vota, controlla la
   ricevuta (`txHash`, `voteHash`, `voterCommitmentHash`).
6. Ricarica la pagina: il form di voto sparisce perché il backend
   trova la ricevuta in Redis e la verifica con
   `hasUserVoted(electionId, commitment)` sul Hardhat node.

Se i passi 4–5 falliscono con `OwnableUnauthorizedAccount`, hai un
mismatch tra `PRIVATE_KEY` configurata in ECS Express e `owner` del
contratto: la soluzione è ridepoloyare `VotingRegistry` con
`INITIAL_OWNER` uguale all'address derivato dalla `PRIVATE_KEY`
corrente, oppure tenere il default (signer #0).

---

## Quando passare a una architettura "vera"

Indicatori che il setup attuale non basta più:

- **Più di un admin che crea elezioni in parallelo** → serve scaling
  orizzontale del task Fargate, e quindi coordinamento più forte (il
  lock Redis copre il caso, ma stai stressando un singolo box).
- **Voti che devono sopravvivere a riavvii della chain** → muoviti su
  Sepolia o un'altra testnet pubblica.
- **Vincoli di privacy/compliance** → serve Secrets Manager + KMS,
  audit log, multi-AZ, security group più stretti.
- **Traffico > qualche req/s** → il Hardhat node è single-threaded e
  Redis su singolo Lightsail diventa il bottleneck.

In quel caso da ECS Express si "graduates" su ECS classico (stesso
cluster, ma task definition e service editabili a mano), si aggiungono
ElastiCache, Secrets Manager, KMS, multi-AZ. Costo: ~$95/mese e HA
pieno.
