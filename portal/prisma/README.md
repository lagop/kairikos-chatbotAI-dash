# Prisma — schema, migrations, seed (KAIA-752)

This directory owns the **Prisma schema and migrations** for the end-client
portal. It is the data-access layer for the Next.js 14 portal (KAIA-723) and
the n8n flows (KAIA-724) that write `ChatbotActivity` rows.

## Models

| Model                  | Purpose                                                        | Writes from        | Reads from         |
|------------------------|----------------------------------------------------------------|--------------------|--------------------|
| `ChatbotClient`        | One row per paying client. Source of truth for tier/goLiveAt.  | backend (Stripe)   | portal + admin     |
| `ChatbotClientUser`    | Maps `nextAuthEmail` → `clientId` (v1: 1:1).                   | backend (signup)   | portal session     |
| `ChatbotActivity`      | T+N timeline rows (T+0, T+3, T+7, T+14).                        | n8n                | portal timeline    |
| `ChatbotConversation`  | Conversation list + transcript (read-only in portal v1).       | n8n                | portal list/detail |

## Row isolation rule (the contract every portal API route must follow)

> Every portal API route **must** resolve `clientId` from
> `ChatbotClientUser.nextAuthEmail = session.user.email` before querying any
> other model. No raw SQL. All reads go through Prisma
> `where: { clientId }` clauses. **Cross-tenant reads are a P0 incident.**

Concretely, every protected route follows this shape:

```ts
// 1. Resolve clientId from the NextAuth session email.
const session = await getServerSession(authOptions);
if (!session?.user?.email) return new Response('Unauthorized', { status: 401 });

const link = await prisma.chatbotClientUser.findUnique({
  where: { nextAuthEmail: session.user.email },
  select: { clientId: true },
});
if (!link) return new Response('Forbidden', { status: 403 });

// 2. Scope every subsequent query to clientId.
const profile = await prisma.chatbotClient.findUnique({
  where: { id: link.clientId },
});
```

`nextAuthEmail` is `UNIQUE`, so a `findUnique` is enough — there is no
ambiguous "which client does this user own" branch in v1. Multi-tenant org
switching (one user owning multiple clients) is a v2 backlog item.

**Do not** rely on Supabase RLS for cross-tenant isolation here. The portal
moved off Supabase Auth (plan rev 3) to NextAuth.js v5 + Resend magic-link,
so the trust boundary is the NextAuth session, not a Postgres RLS predicate.

## Local dev

```bash
# 1. Start the postgres service (from the project root).
docker compose up -d postgres

# 2. Apply migrations (creates the four tables).
npm run prisma:migrate

# 3. Seed two demo clients (Aurora / Ríos).
npm run prisma:seed

# 4. Inspect rows.
npm run prisma:studio
```

The `.env.example` at `portal/.env.example` carries the `DATABASE_URL` the
Prisma CLI and the Next.js server both read. Real values live in
`portal/.env.local` (gitignored) and the VPS secret store.

## Migrations

* `prisma migrate dev --name <name>` during dev — creates a new
  `prisma/migrations/<timestamp>_<name>/migration.sql`.
* `prisma migrate deploy` in CI / VPS deploy — applies pending migrations.
* Migrations commit **separately from application code** (per the Backend
  Developer working rules). One migration = one focused change, no drive-by
  refactors.
* Always ship a rollback note in the migration's PR description. Prisma does
  not generate down-migrations; the rollback is the SQL you would run by
  hand (typically `DROP TABLE` for the new model in reverse dependency
  order).

## Seed

`seed.ts` upserts two clients (Aurora — Starter live, Ríos — Premium
onboarding) plus one activity row and one conversation row each, idempotent
on the unique keys. Test login emails for the magic-link flow:

* `aurora@example.com` — Starter, live
* `rios@example.com` — Premium, onboarding
