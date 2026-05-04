# Voting Platform — Frontend (Next.js)

Frontend per la piattaforma di voto on-chain. Comunica esclusivamente con il
backend Fastify (`../backend`), che a sua volta agisce come relayer verso il
contratto `VotingRegistry`.

> Il frontend **non parla mai direttamente con la blockchain** e **non ha
> accesso a chiavi private**: tutta la sicurezza on-chain è gestita dal
> backend.

## Stack

- [Next.js 14](https://nextjs.org/) — App Router, JavaScript puro (no TS).
- [React 18](https://react.dev/).
- [Tailwind CSS](https://tailwindcss.com/) — UI scritta a mano (niente shadcn
  per restare semplici e senza setup TS).
- [React Hook Form](https://react-hook-form.com/) + [Zod](https://zod.dev/)
  per i form (login, register, creazione elezione, voto).
- [react-hot-toast](https://react-hot-toast.com/) per le notifiche.
- Fetch wrapper centralizzato (`lib/api.js`) — niente TanStack Query, per
  tenere la base di codice minimale.

## Struttura

```
frontend/
  app/
    layout.jsx                       # navbar + toaster
    page.jsx                         # landing → redirect in base al ruolo
    login/page.jsx
    register/page.jsx
    dashboard/page.jsx               # voter — lista elezioni
    elections/[id]/page.jsx          # voter — dettaglio + voto + ricevuta
    admin/
      page.jsx                       # admin dashboard (statistiche)
      elections/page.jsx             # admin — tabella + open/close
      elections/new/page.jsx         # admin — form creazione elezione
      elections/[id]/page.jsx        # admin — dettaglio + lifecycle
    not-found.jsx
    globals.css
  components/
    ui/                              # Button, Input, Card, Badge, Spinner, States
    layout/                          # Navbar, Container, ToastProvider
    auth/RequireAuth.jsx             # client guard con redirect by role
    elections/                       # ElectionCard, StatusBadge, Countdown
    voting/                          # VoteForm (con conferma), VoteReceipt
  hooks/
    useAuth.js                       # legge JWT da localStorage e fa /auth/me
  lib/
    api.js                           # wrapper fetch tipizzato (JSDoc)
    auth.js                          # storage JWT + eventi auth-change
    validators.js                    # zod schemas
    format.js                        # date / hash / countdown
    errors.js                        # mappa ApiError → messaggio leggibile
```

## Setup

```bash
cd frontend
npm install
cp .env.example .env.local
# eventualmente correggi NEXT_PUBLIC_API_URL
npm run dev
```

Il dev server gira su `http://localhost:3000`. Il backend deve essere già
avviato e raggiungibile (default `http://localhost:3001`).

## Variabili d'ambiente

Solo una variabile è richiesta:

| Variabile             | Descrizione                                 | Default                 |
| --------------------- | ------------------------------------------- | ----------------------- |
| `NEXT_PUBLIC_API_URL` | URL base dell'API Fastify (no slash finale) | `http://localhost:3001` |

> `NEXT_PUBLIC_*` viene esposto al browser: non metterci segreti.

## Flussi

### Voter

1. `/register` → crea l'account → login automatico → redirect su `/dashboard`.
2. `/dashboard` mostra tutte le elezioni con badge di stato e countdown.
3. `/elections/:id` mostra dettaglio + on-chain status (`metadataMatches`,
   `totalVotes`).
4. Se `status === "active"` e l'utente non ha ancora votato, viene mostrato
   il form. Selezione → schermata di conferma → invio.
5. Dopo il voto compare la ricevuta con `txHash`, `voteHash` e
   `voterCommitmentHash` troncati.
6. Se l'utente ha già votato (Redis o on-chain), il form viene sostituito da
   un messaggio informativo.

### Admin

1. Bootstrap: il backend crea un admin a partire da `ADMIN_EMAIL` /
   `ADMIN_PASSWORD`. Login da `/login`, redirect automatico su `/admin`.
2. `/admin` — statistiche (totale, schedulate, attive, chiuse).
3. `/admin/elections` — tabella con azioni rapide _Open now_ / _Close_.
4. `/admin/elections/new` — form con array dinamico di opzioni, validazione
   client-side via Zod, errori del backend mostrati come toast.
5. `/admin/elections/:id` — dettaglio completo: stato on-chain, badge
   `metadata verified` / `metadata mismatch`, hash troncati, lifecycle.

## Sicurezza frontend

- **Nessuna chiave privata** lato client: l'utente non ha wallet, tutte le
  transazioni sono firmate dal relayer del backend.
- **JWT in `localStorage`** (`voting.jwt`) — semplice e tipico per SPA.
  L'utente è anche cachato (`voting.user`) per evitare flash UI.
  Limite noto: vulnerabile a XSS. La piattaforma applica `helmet` lato API e
  React fa escaping di default lato view.
- **Auth header** aggiunto da `lib/api.js` solo sulle chiamate `auth: true`.
- **401 → logout automatico**: il wrapper pulisce la sessione ed emette un
  evento `voting:auth-change` su cui `useAuth` reagisce, riportando l'utente
  a `/login` tramite `<RequireAuth>`.
- **Validazioni client-side** con Zod: solo per UX. L'enforcement vero è
  nel backend (Zod + smart contract).
- **`<RequireAuth>`** è una guard client-side. La route resta visibile come
  bundle JS, ma le chiamate API sono tutte autenticate dal backend, quindi
  l'utente non vedrebbe comunque dati protetti.
- **CORS**: il backend è configurato di default con `CORS_ORIGIN=http://localhost:3000`.

## API client

`lib/api.js` espone un singolo oggetto `api` con metodi tipizzati via JSDoc:

| Metodo                     | Endpoint                              | Auth   |
| -------------------------- | ------------------------------------- | ------ |
| `api.register({...})`      | `POST /auth/register`                 | no     |
| `api.login({...})`         | `POST /auth/login`                    | no     |
| `api.getMe()`              | `GET /auth/me`                        | sì     |
| `api.logout()`             | (locale)                              | —      |
| `api.getElections()`       | `GET /elections`                      | no     |
| `api.getElection(id)`      | `GET /elections/:id`                  | no     |
| `api.getElectionStatus(id)`| `GET /elections/:id/status`           | no     |
| `api.createElection({...})`| `POST /admin/elections`               | admin  |
| `api.openElection(id)`     | `POST /admin/elections/:id/open`      | admin  |
| `api.closeElection(id)`    | `POST /admin/elections/:id/close`     | admin  |
| `api.getAdminElections()`  | `GET /admin/elections`                | admin  |
| `api.vote(id, opt)`        | `POST /elections/:id/vote`            | sì     |
| `api.getMyVoteStatus(id)`  | `GET /elections/:id/my-vote-status`   | sì     |

In caso di errore lancia `ApiError` con i campi `{ status, code, message,
issues, details }`. `lib/errors.js#describeApiError(err)` produce un
messaggio leggibile e mostra il primo `issues[].message` per i
`VALIDATION_ERROR`.

## Build / produzione

```bash
npm run build
npm start
```

Il file `.env.local` viene letto al momento del build per `NEXT_PUBLIC_*`,
quindi se cambia l'URL del backend in produzione bisogna ribuildare.

## Note

- Niente TypeScript, niente shadcn, niente TanStack Query per scelta esplicita
  di restare minimali.
- Il countdown è puramente visivo: la verità è on-chain (`status`).
- `metadataMatches` segnala una eventuale manomissione dei dati off-chain.
