# Platform Features — Frontend Reference

This document describes **what you can do on the platform through the
web UI** (`frontend/`, Next.js at `http://localhost:3000`). It is a
user-facing tour of every page, role, and action that the frontend
exposes.

For setup instructions, see [`README.md`](./README.md). For low-level
HTTP details, see [`backend/API.md`](./backend/API.md).

---

## 1. Roles & access model

The platform has exactly **two roles**:

| Role     | How it is created                                     | Default landing page |
| -------- | ----------------------------------------------------- | -------------------- |
| `voter`  | Public self-registration via `/register`              | `/dashboard`         |
| `admin`  | Bootstrapped at backend startup from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (no admin can be created from the UI) | `/admin` |

Authentication is **JWT-based**, stored in `localStorage` under
`voting.jwt`. The token is automatically attached to every authenticated
API call by `lib/api.js`. A `401` response triggers an automatic logout
and a redirect to `/login`.

The `<RequireAuth>` guard protects every authenticated page:

- Not logged in → redirect to `/login?next=<original_path>`.
- Logged in but wrong role → redirect to that role's home page
  (a voter trying to open `/admin/*` is bounced to `/dashboard`, and
  vice-versa).

The navbar adapts to the current role: voters only see *Dashboard*;
admins see *Dashboard*, *Elections*, *New*. Both see their email,
their role tag, and a *Logout* button.

---

## 2. Pages map

```
Public
  /                       Landing — "Login" / "Create account" CTAs
  /login                  Email + password sign-in
  /register               Voter registration (email + password ×2)
  /not-found              404 page

Voter (RequireAuth)
  /dashboard              List of all elections (cards)
  /elections/[id]         Election detail + cast vote + receipt

Admin (RequireAuth role="admin")
  /admin                  KPI dashboard + recent elections
  /admin/elections        Full table with quick lifecycle actions
  /admin/elections/new    Create election form
  /admin/elections/[id]   Election detail + lifecycle controls
```

The landing page (`/`) auto-redirects authenticated users to the
correct home page, so most users never see it after their first login.

---

## 3. Public area (no login required)

### 3.1 Landing — `/`

- Marketing card with a one-sentence pitch and two CTAs: **Login** and
  **Create account**.
- Already-authenticated users are redirected to `/admin` or
  `/dashboard` depending on their role.

### 3.2 Register — `/register`

You can create a **voter** account by providing:

- email (validated, lowercased, trimmed),
- password (min 8 chars, max 200),
- password confirmation (must match).

On success the form **immediately logs you in** (it calls
`POST /auth/register` followed by `POST /auth/login`) and lands you on
`/dashboard`. Errors are surfaced as toasts and inline field errors.

> Admin accounts cannot be created from the UI — they only come from
> the backend bootstrap.

### 3.3 Login — `/login`

Sign in with email + password. On success:

- A toast `"Welcome back"` confirms.
- You are redirected either to `?next=<path>` (if the guard sent you
  here from a protected page) or to your role's home page.

Failed logins are surfaced via toast (`"Invalid credentials"`,
rate-limit messages, etc.).

> The backend rate-limits login attempts (default: 5 per minute per
> IP+email). Too many failures will produce a `Too many requests` toast
> until the window resets.

---

## 4. Voter experience

### 4.1 Dashboard — `/dashboard`

A 1–3 column grid of **election cards**, one per election known to the
backend. Each card shows:

- election ID,
- title and a short description preview,
- a **status badge** (`scheduled` / `active` / `closed`),
- a **countdown** (time to start, time to end, or `Closed`),
- the number of options.

Empty state: `"No elections yet — when an admin creates an election it
will show up here."`. Errors include a **Retry** button.

Clicking a card opens `/elections/[id]`.

### 4.2 Election detail — `/elections/[id]`

Three things are loaded in parallel: the off-chain election record, the
on-chain status, and the user's personal vote status.

The header shows:

- election ID, title, description,
- status badge from the chain (authoritative),
- a `metadata verified` / `metadata mismatch` badge — green when the
  on-chain `metadataHash` still matches the off-chain document, red
  when someone has tampered with the data.

A grid of metrics displays:

- start and end timestamps (formatted),
- on-chain `totalVotes`,
- a live countdown ("time remaining" / "starts in" / "—"),
- truncated `metadataHash`,
- truncated creation `txHash` (when known).

#### Casting a vote

The "Cast your vote" card behaves differently depending on state:

| Situation                               | What you see                                       |
| --------------------------------------- | -------------------------------------------------- |
| Election `active` and you have not voted | The **vote form** with radio options              |
| You already voted                       | Green info box: *"You already voted in this election. Each user can vote only once."* |
| Election `created` (not started)        | Grey info box: *"This election has not started yet."* |
| Election `closed`                       | Grey info box: *"This election is closed."*       |

The vote form requires a **two-step confirmation**:

1. Select one option → click **Continue**.
2. An amber confirmation banner asks you to confirm: *"Confirm your
   vote for **'<choice>'**. Votes are final and cannot be changed."*
3. Click **Confirm vote** → the backend signs the `castVote`
   transaction with the relayer key and waits for confirmation.

On success a toast says *"Vote recorded on-chain"* and a **Vote
Receipt** card appears beside the form (or replacing it on small
screens), containing:

- `Cast at` timestamp,
- truncated `Tx hash` (with full value as tooltip),
- block number,
- truncated `Vote hash` (`keccak256(electionId, option, nonce)`),
- truncated `Voter commitment` (`keccak256(userId, electionId, salt)`).

Even if you reload the page or come back later, the receipt is
re-rendered because the backend still has the record (and would
double-check on-chain via `hasUserVoted` if Redis were ever wiped).

---

## 5. Admin experience

All admin pages live under `/admin/*` and require `role === "admin"`.

### 5.1 Admin dashboard — `/admin`

Top-level KPIs computed from the admin election list:

- **Total** elections,
- **Scheduled** (status `created`),
- **Active**,
- **Closed**.

A *Recent elections* card lists the latest 5 elections (clickable,
each showing ID, title, option count and current status), with a
"View all →" link to `/admin/elections`. A prominent **+ New
election** button leads to the creation form.

### 5.2 Elections table — `/admin/elections`

Full table with one row per election, sortable by visual scanning.
Columns:

| Column   | Content                                                  |
| -------- | -------------------------------------------------------- |
| `#`      | numeric election ID                                      |
| `Title`  | election title (clickable) + option count                |
| `Status` | colored status badge                                     |
| `Window` | start time + end time                                    |
| `Actions`| **Open now** / **Close** (state-dependent) + **View**    |

Action buttons are state-dependent:

- **`scheduled`** elections show a blue **Open now** button →
  immediately calls the contract's `openElection` (sets `startTime`
  to `block.timestamp`).
- **`active`** elections show a red **Close** button (with a confirm
  dialog *"Close election #N? This is final."*) → calls
  `closeElection`.
- **`closed`** elections only show **View**.

Each action shows a per-row spinner and a success/error toast, then
reloads the table.

### 5.3 New election — `/admin/elections/new`

Form to create an election. Fields:

| Field         | Validation                                                   |
| ------------- | ------------------------------------------------------------ |
| Title         | required, ≤ 200 chars                                        |
| Description   | optional, ≤ 2000 chars                                       |
| Options       | dynamic array; at least **2**, at most **20**, no empties    |
| Start time    | `datetime-local`, must be in the future (enforced server-side and on-chain) |
| End time      | `datetime-local`, must be **after** start time               |

UX details:

- Default start time = now + 5 min, default end time = now + 1 hour.
- **+ Add option** appends a new option row.
- Each option has a **Remove** button (disabled when only 2 options
  remain).
- The submit button is labeled **Create on-chain** to make the side
  effect explicit.
- On success: toast *"Election #N created"* and redirect to the new
  election's admin detail page. Server-side errors (e.g. window in the
  past, contract revert) are surfaced as toasts.

### 5.4 Admin election detail — `/admin/elections/[id]`

Same metrics card as the voter view, but enriched and never gated:

- shows the **block number** of the creation transaction,
- if the chain is unreachable, shows a `chain unreachable` warning
  badge instead of `metadata verified` / `metadata mismatch`.

A dedicated **Lifecycle** card exposes the on-chain controls:

- `created` → **Open now** (calls `openElection`).
- `active` → **Close election** (calls `closeElection`, with confirm
  dialog).
- `closed` → static text *"This election is closed."*.

A separate **Options** card lists all the options in the original
order. This is the only place where an admin can review the full ballot
text after creation (options cannot be edited after deployment — the
on-chain `metadataHash` would no longer match).

---

## 6. On-chain transparency surfaces in the UI

Several UI elements are designed to expose what happened on-chain so
that voters and admins can independently verify integrity:

- **Status badge** — colored chip (`scheduled` / `active` /
  `closed`) wired to the **chain status**, not just the off-chain
  record.
- **`metadata verified` / `metadata mismatch`** — the backend
  re-hashes the off-chain document and compares it to the on-chain
  `metadataHash`. A mismatch means the off-chain copy has been
  tampered with.
- **`totalVotes`** — read directly from the contract.
- **Truncated hashes** (`metadataHash`, `txHash`, `voteHash`,
  `voterCommitmentHash`) — displayed in monospace with the full value
  available via tooltip, for manual cross-checking against a block
  explorer.
- **Vote receipt** — proof-of-vote that the user can keep / screenshot,
  containing all the hashes needed to verify the vote on-chain
  without revealing the actual choice.

---

## 7. UX safety nets

The frontend layers several safeguards to prevent mistakes and to make
errors recoverable:

- **Two-step vote confirmation** with explicit "votes are final"
  warning.
- **Confirm dialogs** before destructive admin actions
  (`closeElection`).
- **Disabled buttons** when an action would obviously fail (no option
  selected, fewer than 2 options remaining, in-flight submission).
- **Per-button spinners** during pending requests, so the user never
  double-submits.
- **Toast notifications** for both success and failure of every
  mutating action.
- **Inline form errors** powered by Zod + React Hook Form for fast
  client-side feedback. Server-side validation always wins, and its
  message is surfaced too.
- **Empty / error / loading states** are all distinct and consistent
  across pages (`PageSpinner`, `EmptyState`, `ErrorState` components).
- **Auto-logout on `401`** keeps stale sessions from confusing the UI.
- **Live countdowns** make the time component of "active" tangible
  without requiring page reloads.

---

## 8. What you cannot do from the frontend (by design)

To keep the security model clean, the UI deliberately does **not**
expose:

- Editing or deleting an election after creation (the on-chain
  `metadataHash` would no longer match).
- Editing election options (same reason).
- Viewing other voters' choices, identities, or vote→user mappings —
  the chain only stores opaque hashes, and the backend never returns
  vote contents.
- Promoting a user to admin, or any user-management UI. Admins are
  created exclusively at backend boot time.
- Direct interaction with a wallet, MetaMask, RPC endpoint, or
  blockchain network — the relayer is the sole signer.
- Uploading a private key, ABI, or contract address — those live in
  the backend's `.env` only.

If you need any of the above, it must be done at the backend (or
contract) layer; the frontend is intentionally a thin, audited surface
on top of the relayer API.

---

## 9. Quick-reference cheat sheet

| I want to…                                         | Where in the UI                                |
| -------------------------------------------------- | ---------------------------------------------- |
| Create a voter account                             | `/register`                                    |
| Sign in                                            | `/login`                                       |
| See all elections (as a voter)                     | `/dashboard`                                   |
| Read an election's details + on-chain status      | `/elections/[id]`                              |
| Cast a vote                                        | `/elections/[id]` (active election only)       |
| See my vote receipt                                | `/elections/[id]` (after voting)               |
| See KPIs across all elections (admin)             | `/admin`                                       |
| Create a new election                              | `/admin/elections/new`                         |
| Open an election before its scheduled start       | `/admin/elections` or `/admin/elections/[id]`  |
| Close an active election (emergency stop)         | `/admin/elections` or `/admin/elections/[id]`  |
| Verify off-chain metadata vs on-chain hash        | Election detail (header badge)                 |
| Sign out                                           | Navbar → **Logout**                            |
