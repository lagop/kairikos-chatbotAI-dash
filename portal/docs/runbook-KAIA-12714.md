# KAIA-12714 — Operator forgot-password runbook

> **Audience:** the next operator who joins the team, and the engineer who
> wakes up to provision them. The 1Password-share-and-manual-rotation
> workaround from [KAIA-12227](/KAIA/issues/KAIA-12227) is the
> **fallback only** — the canonical path for new operators is the
> self-service forgot-password flow described here.

**Issue:** [KAIA-12714](/KAIA/issues/KAIA-12714)
**Replaces:** the 1Password-share workaround.
**Scope:** the `Operator` Prisma model in the portal Prisma schema
(`portal/prisma/schema.prisma`). Backed by the same PostgreSQL database
the rest of the portal uses (in production: the Supabase DB
`db.ikexqreuvoqwvwopftkt.supabase.co:5432`, accessed via
`DATABASE_URL`).

---

## TL;DR

1. **Engineer / on-call:** insert a new `Operator` row in the portal
   Prisma DB (`isActive=true`, `passwordHash=null`, `totpSecret=null`).
   The hash gets written by the operator themselves when they click the
   setup link. **For staging**, use
   `portal/scripts/seed-staging-operator.ts` (the existing script from
   [KAIA-1585](/KAIA/issues/KAIA-1585)).
2. **Operator:** open `https://portal.kairikos.com/admin/forgot-password`,
   enter their email, click the link in the Resend email, choose a
   password.
3. **Operator:** sign in at `https://portal.kairikos.com/admin/login`.
4. **Engineer / on-call:** verify the operator can sign in.

No secrets leave the provider store. No plaintext token, password, or
Resend message id is logged anywhere.

---

## Provisioning steps (the canonical path)

### 1. Add the Operator row

In production, run a Prisma migration or `prisma db execute` with:

```sql
INSERT INTO "Operator" (id, email, "isActive", "passwordHash", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(),
  'new-operator@kairikos.com',  -- the operator's actual email
  true,
  null,                          -- filled in by the operator themselves
  now(),
  now()
)
ON CONFLICT (email) DO NOTHING;
```

For **staging**, use the existing
`portal/scripts/seed-staging-operator.ts` script:

```bash
cd portal
SUPABASE_URL=https://ikexqreuvoqwvwopftkt.supabase.co \
SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
OPS_STAGING_OPERATOR_EMAIL=ops-staging@kairikos.com \
OPS_STAGING_OPERATOR_PASSWORD='<any-strong-test-password>' \
  npx tsx scripts/seed-staging-operator.ts
```

The script is idempotent — re-running is a no-op on existing rows.

### 2. Operator triggers the forgot-password flow

The operator opens `https://portal.kairikos.com/admin/forgot-password`,
enters their email, and clicks **Enviar enlace**. The page POSTs to
`/api/operator/forgot-password`:

```bash
curl -X POST https://portal.kairikos.com/api/operator/forgot-password \
     -H 'content-type: application/json' \
     -d '{"email":"new-operator@kairikos.com"}'
```

Expected response: `200 {"ok":true}`. The route silently returns
`{"ok":true}` if the email is unknown to prevent email enumeration. If
Resend or the DB is misconfigured, the route returns 500/503 (fail-closed).

The route mints a `PasswordResetToken` row (sha256-hashed, 2h TTL,
single-use, matching the customer route's contract) and dispatches a
Resend email with a link to
`/admin/reset-password?token=…&email=…`.

### 3. Operator sets their password

The operator clicks the link in the email, lands on
`/admin/reset-password`, picks an 8+ character password, and submits. The
page POSTs to `/api/operator/reset-password`:

- The route looks up the `PasswordResetToken` row by sha256 of the
  provided token (single-use; burns it on success).
- The route looks up the `Operator` row by email, confirms `isActive`.
- The route writes a fresh `argon2id` hash to `Operator.passwordHash`
  via `hashPassword` from `src/lib/operator-crypto.ts`. The verify path
  in `/api/operator/login` already uses the matching `verifyPassword` —
  no format drift.
- The route also revokes all of the operator's existing
  `OperatorSession` rows in the same transaction so a stolen pre-reset
  session cookie cannot outlive the password change.
- The operator is redirected to `/admin/login` on success.

### 4. Operator signs in + enrolls TOTP

The operator signs in via the standard `/admin/login` flow. After the
password write they are routed to `/admin/portal` which prompts them
to enroll TOTP via `/api/operator/totp/enroll` (see [KAIA-1909](/KAIA/issues/KAIA-1909)).

---

## Rollback (operator lost their device / lockout)

If the operator row needs to be reset (lost device, lockout), the only
safe path is:

1. Confirm the operator's identity out-of-band (call them).
2. Clear `passwordHash`, `totpSecret`, and `totpEnrolledAt` (do not
   delete the row — it is the audit-of-record):

   ```sql
   UPDATE "Operator"
   SET "passwordHash" = NULL,
       "totpSecret" = NULL,
       "totpEnrolledAt" = NULL,
       "updatedAt" = now()
   WHERE email = 'new-operator@kairikos.com';
   ```

3. Revoke all sessions so the lost device cannot reconnect:

   ```sql
   UPDATE "OperatorSession"
   SET "revokedAt" = now()
   WHERE "operatorId" = '<operator-uuid>' AND "revokedAt" IS NULL;
   ```

4. The operator re-runs step 2 to get a new setup link.

**Never** delete an Operator row in production without explicit CEO
approval and a backup of the row — Operator rows are referenced by
`OperatorSession`, `OperatorRecoveryCode`, `OperatorSettingsAudit`,
and the wizard-step `approvedByOperatorId` foreign key.

---

## Verification (CI smoke)

The portal repo ships a regression smoke that asserts:

- the new `/api/operator/forgot-password` uses Prisma `Operator` + mints
  a sha256-hashed token + silently returns `ok:true` for unknown emails
  + burns the token on `email_send_failed` + applies IP + email rate
  limiting;
- the new `/api/operator/reset-password` looks up by email + sha256
  hash + writes `Operator.passwordHash` via `hashPassword` from
  `src/lib/operator-crypto.ts` + burns the token + revokes existing
  sessions + never logs the plaintext password or token;
- `src/lib/operator-crypto.ts` `hashPassword` uses argon2id via
  `@node-rs/argon2` (no format drift vs. existing Operator rows);
- the customer `/api/portal/forgot-password` and
  `/api/portal/reset-password` routes are still wired to the customer
  `ChatbotClientUser` → `User` model only (no Operator leakage);
- the `/admin/forgot-password` and `/admin/reset-password` pages now
  POST to `/api/operator/*` (NOT `/api/portal/*`).

```bash
cd portal
npm run smoke:kaia-12714
```

Exit code 0 = all assertions passed.

---

## Security checklist

- [x] Token: 32 random bytes hex-encoded (64 chars), stored as sha256.
- [x] TTL: 2 hours (matches the customer route's contract).
- [x] Single-use: `passwordResetToken.update({ usedAt: now })` on the
      first successful read; subsequent reads return `invalid_or_expired_token`.
- [x] Hash at rest: `Operator.passwordHash` uses argon2id via
      `@node-rs/argon2`, matching the existing Operator rows seeded by
      `seed-staging-operator.ts`.
- [x] Email enumeration: the route returns `{"ok":true}` for unknown
      emails and for inactive operators — no timing-based or payload-
      based leak.
- [x] No plaintext secrets logged; no token, password, or Resend message
      id in any log line.
- [x] Email dispatch failure → 500 `{"error":"email_send_failed"}`
      with the token row burned so a retry does not silently succeed.
- [x] Rate-limit: in-memory IP (20 / 15 min) + email (5 / 15 min)
      rate limiter on `/api/operator/forgot-password` matches the
      `/api/operator/login` rate-limit pattern.
- [x] Session revocation on password reset — a stolen pre-reset session
      cookie cannot outlive the password change.
- [x] Customer route untouched: see
      `portal/scripts/smoke-kaia-12714-operator-forgot-password.ts`.

---

## Related

- [KAIA-12701](/KAIA/issues/KAIA-12701) — the immediate unblock that
  surfaced this follow-up (now `done`).
- [KAIA-12227](/KAIA/issues/KAIA-12227) — the parent ticket for the
  operator dashboard / verify chain.
- [KAIA-2103](/KAIA/issues/KAIA-2103) — the customer
  forgot-password flow that this operator path mirrors.
- [KAIA-1585](/KAIA/issues/KAIA-1585) — the staging Operator seed
  script.
- [KAIA-1909](/KAIA/issues/KAIA-1909) — TOTP step-up flow that runs
  after the operator signs in for the first time.
- [KAIA-1702](/KAIA/issues/KAIA-1702) — guardrail: no plaintext secrets
  in any adapter env.
- `portal/src/app/api/operator/forgot-password/route.ts` — the dispatch route.
- `portal/src/app/api/operator/reset-password/route.ts` — the consume route.
- `portal/src/app/admin/forgot-password/page.tsx` — the forgot-password UI page.
- `portal/src/app/admin/reset-password/page.tsx` — the reset-password UI page.
- `portal/src/lib/operator-crypto.ts` — the argon2id `hashPassword` /
  `verifyPassword` helpers.