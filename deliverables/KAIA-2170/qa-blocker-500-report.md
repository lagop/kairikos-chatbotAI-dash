## QA Sign-off — BLOCKER: portal layout 500s every /portal/* route

KAIA-2312 is marked done and a new build was promoted (last-modified: `Sun, 28 Jun 2026 10:17:55 GMT`), so the deploy landed. But the new build is broken at runtime:

| Route | Expected | Actual |
|---|---|---|
| `/portal` | redirect to `/portal/login` | **HTTP/2 500** |
| `/portal/login` | credentials form | **HTTP/2 500** |
| `/portal/setup-password` | setup form | **HTTP/2 500** |
| `/portal/forgot-password` | forgot form | **HTTP/2 500** |
| `/portal/reset-password` | reset form | (likely 500, same root cause) |
| `/api/auth/providers` | NextAuth providers JSON | **HTTP/2 500** |
| `/admin/login` | admin login form | HTTP/2 200 ✓ |
| `/admin/portal` | redirect to login | HTTP/2 500 |

### Root cause

`portal/src/app/portal/layout.tsx` calls `getSession()` unconditionally before the `isPublicPortalPath(pathname)` guard:

```ts
export default async function PortalLayout({ children }) {
  const hdrs = await headers();
  const pathname = hdrs.get('x-pathname') ?? '';
  const session = await getSession();          // <-- throws on staging
  if (!isPublicPortalPath(pathname) && !session.hasClientAccess) {
    redirect(target);
  }
  ...
}
```

`getSession()` calls `auth()` (NextAuth v5) which initialises the Prisma client. With the new Credentials providers and `prisma.user.findUnique(...)` lookup, `auth()` throws because one or more of:

- `AUTH_SECRET` is unset / different from the previous magic-link build
- `DATABASE_URL` (or the `portal` schema connection) is missing
- Prisma client was not regenerated for the new `User` / `Operator` tables added by KAIA-2168

`/api/auth/providers` also returns 500, confirming NextAuth itself is broken (it cannot list the providers it would serve).

`/admin/login` works because `src/app/admin/layout.tsx` does not call `getSession()` / `auth()` — it just renders the login form.

### Why this matters for sign-off

The §4.3 acceptance criteria include:

- "operator login: wrong password rejected; correct password lands on `/admin/portal`"
- "cross-tenant test: client A's session cannot read client B's data"
- "rate-limit: 11th wrong password → 429"
- "Resend no longer fires on login"

All four require a working client-side login → cookie → session → API call chain. With every `/portal/*` route 500-ing, none of them can run.

### Reproducer

```
$ for path in / /portal /portal/login /portal/setup-password /portal/forgot-password /portal/reset-password /api/auth/providers /admin/login /admin/portal; do
    echo -n "$path → "
    curl -s -o /dev/null -w "%{http_code}\n" -L --max-redirs 0 https://project-fxidg.vercel.app$path
  done
/ → 307
/portal → 500
/portal/login → 500
/portal/setup-password → 500
/portal/forgot-password → 500
/portal/reset-password → 500
/api/auth/providers → 500
/admin/login → 200
/admin/portal → 500
```

### Unblock actions

**Backend Developer** (KAIA-2168 owner):

1. Confirm `AUTH_SECRET` is set on the Vercel preview project (`Settings → Environment Variables`) and matches the value the NextAuth JWT was signed with during the merge build.
2. Confirm `DATABASE_URL` (or the portal's connection-string env var) is set and points at the staging Supabase Postgres.
3. Confirm `prisma generate` ran during the Vercel build (check the build log for the `prisma generate` step before `next build`). The new `User` and `Operator` models from the KAIA-2168 migration require a regenerated client.
4. As a hotfix / defense-in-depth, restructure `portal/src/app/portal/layout.tsx` so `isPublicPortalPath(pathname)` is checked **before** `getSession()` is called. Public auth pages should never depend on a live session.

Once those are fixed and `/portal/login` returns 200 with the credentials form, QA re-runs the full §4.3 sign-off.

artifact: /paperclip/instances/default/projects/fe217b5c-badf-4f17-ab20-f089478a35c7/bbe7754b-a8a8-4e1d-86b6-8cbbc4cfa3a4/_default/deliverables/KAIA-2170/staging-evidence.txt