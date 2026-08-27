# VIXART OS

Internal operating system for **SOCIETE VIXART SARL** — Agadir.
Replaces the agency's spreadsheets and WhatsApp memory.

| | |
|---|---|
| Registered name | SOCIETE VIXART SARL |
| Trade register | RC 69627 — Tribunal de Commerce d'Agadir |
| ICE | 003979570000062 |
| Tax ID (IF) | 73161069 |
| Activity | Advertising agency |
| Registered office | Bureau AB 403, Imm A9, Technopole II Bensergaou, Agadir |

Single organisation, one active engagement at a time ("Monk Mode"). No
multi-tenancy, no client portal, no client logins. Five accounts, two roles:
`admin` (Amin) and `member` (the team).

The interface is in English. Money keeps the Moroccan format — `1 234,56 DH`,
non-breaking space for thousands, decimal comma — because that is what an
invoice issued in Morocco has to show; screens and issued documents must not
disagree.

---

## Build progress

| Step | Contents | State |
|---|---|---|
| **1** | Foundation: Docker, PostgreSQL, volumes, migrations, backup + restore, `money.ts`, `fiscal.ts` | **Done** |
| **2** | Auth + CRM (contacts, WhatsApp, ICE, pipeline, timeline) | **Done** |
| **3** | Services with versioned prices; quotes, invoices and credit notes — gapless numbering, immutability, A4 PDF | **Done** |
| **4** | Projects and tasks with two-step sign-off, attachments, equipment register | **Done** |
| **5** | Finance ledger, recurring costs, VAT position, dashboard, CSV exports | **Done** |
| **6** | Fiscal calendar and effort log | **Done** |
| **7** | ~~Agent layer — two conversational agents over the books and the work~~ | **Removed**, see below |

Everything above is shipped and covered by migrations `0000`–`0032`. Later steps
arrived out of order — companies, deals, projects and tasks came in as one Work
module, and team management and recurring entries followed — so the table is a
summary of what exists, not a chronology of the commits.

### What is deliberately not built

| | Why |
|---|---|
| Client portal | Excluded from v1: clients never log in |
| Sending anything — email, WhatsApp, filings | Nothing in this system contacts anyone. Every document is drafted here and sent by a person |
| A withholding rate | Seeded at 0 until the accountant confirms it. Guessing a tax rate is worse than leaving it visibly unset |
| Service prices | Seeded at 0. Pricing is the founder's decision, not a default |

---

## The agent layer, and why it is gone

Two conversational agents were built and then removed: **Le Comptable** over the
books and **Le Chef** over the work. They worked the way the rest of this system
works — each connected as its own PostgreSQL role, so what it could do was a
grant rather than a promise in a prompt, and every figure came back with the
rows it was read from.

They were removed for one reason: every question costs money at the API, and
nothing else in this app has a running cost. That is a bad trade for a five
person agency whose books were, at the time, empty.

**The removal is in the database, not just the code.** `drizzle/0032` drops all
29 agent policies and the four helper functions, and restores
`app.enforce_task_signoff`, `app.enforce_task_insert` and `app.issue_document`
to their human-only form. `scripts/apply-grants.ts` revokes and **drops both
roles**, and does so on every start, so a database restored from an older backup
is cleaned up too. Deleting the code alone would have left two logins that could
still read the books — a role is not made safe by the absence of code that uses
it, because anyone holding the password can connect directly.

Two things deliberately stayed:

- **`declaration`, `effort_log` and `capacity`** — empty tables with no
  remaining agent dependency. The fiscal calendar and the effort log are
  ordinary business records a later screen could surface. Dropping a table is
  destructive and nothing was gained by it.
- **`agent@vixart.local` and `chef@vixart.local`** — the activity log is
  append-only, and one of them is the actor on rows already in it. Removing the
  account would mean rewriting history, which is the one thing an append-only
  log exists to prevent. Both hold `NO-LOGIN` in place of a password hash and
  cannot authenticate.

The work is in the history if it is ever wanted back: commits `3c94dcc`,
`1d32421` and `273ce14`.

---

### Configuration

No external API keys. The stack talks to nothing but its own database.

The team is treated as **prestataire**, so no CNSS or IR deadlines are tracked. The
`kind` column in `declaration` already accepts both, so switching to salarié is a
data change, not a migration — see the note at the top of `drizzle/0025`.


## Install

Requirements: **Docker** (or Colima) and **Node 22+** for the local tooling.

```bash
git clone <repo> && cd vixart-os
cp .env.example .env          # then replace every CHANGE_ME value
openssl rand -base64 32       # for AUTH_SECRET
docker compose up -d --build  # migrations + seed run automatically
docker compose logs -f app    # follow start-up
```

The application listens on `http://localhost:${APP_PORT}` (see `.env`).

> **Port note.** `APP_PORT` is `4000` on this machine: port 3000 is taken by the
> visionxart.com marketing site in development. Set whatever you prefer on the VPS.

Everything else goes through `make`:

```bash
make help
```

### Node version

The project requires **Node 22 or newer** (`engines` in `package.json`).
On this machine `node` still points at a manual 20.11 install in `~/.local/node`.
Node 22 is installed via Homebrew but shadowed. To use it:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

Add that to `~/.zshrc` to make it permanent. Without it `npm test` fails with
`does not provide an export named 'styleText'`. The Docker image already ships
Node 22 — this only affects commands run on the Mac.

### Team accounts

The seed creates five accounts sharing the initial password from
`SEED_DEFAULT_PASSWORD` in `.env`. **The application blocks every screen until
each member sets their own password** — it is not a dismissible reminder.

| Address | Name | Role |
|---|---|---|
| amin@vixart.ma | Amin — Founder / CEO | admin |
| aymen@vixart.ma | Aymen — Cinematic Director | member |
| azzedine@vixart.ma | Azzedine — Editor & Motion Design | member |
| adam@vixart.ma | Adam — Community & Social Media Manager | member |
| mohamed.amine@vixart.ma | Mohamed Amine — Creative Director & Designer | member |

> The `@vixart.ma` domain is an assumption. To use another one, edit
> `seed/vixart.seed.ts` **before** the first start.

---

## Backup and restore

> This section is written to be followed without being an engineer.
> The commands are typed in Terminal, from the project folder.
>
> *If you would rather have this section in French for someone non-technical,
> say so and it will be added back alongside the English.*

### Where the data lives

Three **named Docker volumes**. They are independent of the containers:
removing, rebuilding or updating the application does not touch them.

| Volume | Contents |
|---|---|
| `vixart_pgdata` | The whole database: clients, documents, finance |
| `vixart_uploads` | Attached files (attachments, logos, receipts) |
| `vixart_backups` | The automatic backups |

### What happens automatically

A backup runs **every night at 03:00** (Casablanca time), plus one every time
the stack starts. The **last 30** are kept; beyond that the oldest is deleted
automatically.

### See the existing backups

```bash
make backups
```

The most recent is at the bottom. The name carries date and time:
`vixart_2026-08-15_030000.sql.gz` = 15 August 2026 at 03:00.

### Take a backup right now

Do this before anything risky.

```bash
make backup
```

### Restore a backup

> ### ⚠️ WARNING — DESTRUCTIVE OPERATION
> Restoring **overwrites the current database**. Everything entered **after**
> the date of the chosen backup is **permanently lost**. Use it only when data
> has genuinely been lost or corrupted.

1. Find the file to restore:

```bash
make backups
```

2. Run the restore with the exact file name:

```bash
make restore FILE=vixart_2026-08-15_030000.sql.gz
```

3. The script prints a warning and asks you to type **`RESTORE`** in capitals.
   Anything else cancels without changing a thing.

**Safety net:** before overwriting anything, the script backs up the current
state. If the restore turns out to be a mistake, the state from just before is
the newest file in `make backups`.

### Stop the application without losing data

```bash
make down
```

All three volumes stay intact. `make up` brings everything back.

### The command never to type

```
docker compose down -v
```

The `-v` **destroys all three volumes**: the database, the attached files **and
every backup**. Nothing would be left to restore from.

The `Makefile` only exposes this as `make danger-reset`, behind a warning and a
full-sentence confirmation. It exists to start from a genuinely blank database
on a test machine.

### Copy the backups off the server

A Docker volume lives on the same disk as the application. If the VPS is lost,
the backups are lost with it. To pull a copy somewhere else:

```bash
docker cp vixart_backup:/backups ./vixart-backups
```

Do this at least monthly, onto an external disk or a cloud drive.

---

## Architecture

```
docker-compose.yml     3 services (app, db, backup), 3 named volumes
Dockerfile             Next.js standalone application image, Node 22
Makefile               operations commands — make help

drizzle/               numbered SQL migrations (never `push`)
  0000_foundation.sql        app_user, client, fiscal_rate
  0001_foundation_rules.sql  RLS, triggers, checks, session context
  0002_crm.sql               contact, interaction, must_change_password
  0003_crm_rules.sql         sign-in lookup, password change, CRM policies
  0004_english_messages.sql  database error messages in English

scripts/
  entrypoint.sh        migrations → privileges → seed → server
  migrate.ts           applies the missing migrations
  apply-grants.ts      (re)creates the application role and its privileges
  backup.sh            one timestamped dump + prune beyond 30
  backup-daemon.sh     the `backup` container nightly loop
  restore.sh           guided restore, with confirmation

seed/vixart.seed.ts    team, real pipeline, tax parameters — idempotent

src/
  auth.ts              Auth.js, credentials provider, JWT sessions
  lib/money.ts         centime arithmetic (bigint), 1 234,56 DH format
  lib/fiscal.ts        versioned rates, excl. VAT / VAT / incl. VAT / withholding
  lib/format.ts        dates and WhatsApp links, Casablanca time
  db/schema.ts         Drizzle schema
  db/index.ts          two pools: application role (RLS) and owner role
  db/session.ts        withUser() — binds the session to the RLS context
  components/ui.tsx    interface primitives, two colours
  app/(app)/           the signed-in application
```

### Two PostgreSQL roles, not one

`vixart_owner` owns the tables and applies migrations.
`vixart_app` runs the application queries: `NOSUPERUSER`, `NOBYPASSRLS`, **no
DDL rights**. It can neither create nor drop a table, and row level security
genuinely applies to it.

Every table is under `FORCE ROW LEVEL SECURITY`: the policies hold even for the
owner. A misconfiguration pointing the application at the wrong role cannot
silently open the boundary.

### How a session reaches the database

`withUser()` opens a transaction, injects `app.user_id` and `app.user_role` with
`set_config(..., true)` — transaction-local — then runs the work. The pool
recycles connections between requests; a plain `SET` would leak one user identity
into the next request. The role handed to PostgreSQL comes from the signed JWT,
never from a URL.

### Money never passes through a float

Every amount is a `BIGINT` of centimes in the database and a `bigint` in
JavaScript. `src/lib/money.ts` explicitly rejects a non-integer `number`:
`19.99 * 100 === 1998.9999999999998`, and an invoice wrong by one centime is a
wrong invoice.

### Tax rates are versioned, never edited

The `fiscal_rate` table carries an `effective_from` date and a trigger that
**refuses any update or delete** of an existing version. Changing a rate means
inserting a new dated version. A document already issued keeps the rate copied
onto it at issue time.

> **Withholding at source (art. 117 bis CGI)** — the rate is seeded at **0**,
> deliberately. It depends on VIXART tax situation and on each client: it must be
> entered by Amin on the accountant advice, not guessed. While it is 0,
> "Net to collect" equals "Total incl. VAT".

---

## Tests

```bash
npm test
```

27 tests cover the money arithmetic and the document totals: rounding, float
traps, the Moroccan format, 0% VAT, withholding at source. The tests for gapless
numbering and document immutability arrive at step 3, with the tables they need.

---

## Changing the schema

```bash
npm run db:generate        # writes a new numbered file into drizzle/
# read the generated SQL before applying it
make migrate
```

> Never run `drizzle-kit push` against the production database: it changes the
> schema without a versioned file and can drop columns — and therefore data —
> without a trace.
