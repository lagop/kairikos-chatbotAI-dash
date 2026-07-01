// =============================================================================
// KAIA-2872 — Prisma DATABASE_URL pooler-flags helper.
//
// The Supabase transaction-mode pooler (port 6543) and Prisma's default
// extended-query prepared-statement cache are mutually incompatible. When
// a Lambda invocation recycles through PgBouncer, the next invocation
// re-registers `s1` on the same backend connection and Postgres throws
// `42P05 prepared statement "s1" already exists`.
//
// The canonical Prisma workaround is to disable the prepared-statement
// cache at the connection-string level:
//   ?pgbouncer=true&connection_limit=1
//
// This helper appends those flags to a Postgres URL when missing. It is a
// pure function with no side effects so it is unit-tested in
// `tests/unit/prisma-pg-flags.test.ts`.
//
// Behaviour summary:
//   - undefined / empty input → returned as-is (caller treats as "no DB").
//   - non-postgres schemes (sqlite, mysql, …) → returned unchanged.
//   - postgres URL with no flags           → adds `?pgbouncer=true&connection_limit=1`.
//   - postgres URL with only one flag       → adds the missing one.
//   - postgres URL with both flags already  → returned unchanged.
//   - URL with a fragment (`#…`)             → preserved.
//   - URL with a custom port / path         → preserved.
// =============================================================================

export function ensurePgBouncerFlags(
  rawUrl: string | undefined | null,
): string | undefined {
  if (!rawUrl) return rawUrl ?? undefined;
  if (!/^postgres(?:ql)?:\/\//i.test(rawUrl)) return rawUrl;
  const hashIdx = rawUrl.indexOf('#');
  const pathEnd = hashIdx === -1 ? rawUrl.length : hashIdx;
  const beforeHash = rawUrl.slice(0, pathEnd);
  const fragment = hashIdx === -1 ? '' : rawUrl.slice(hashIdx);
  const qIdx = beforeHash.indexOf('?');
  const base = qIdx === -1 ? beforeHash : beforeHash.slice(0, qIdx);
  const query = qIdx === -1 ? '' : beforeHash.slice(qIdx + 1);
  const params = new URLSearchParams(query);
  let mutated = false;
  if (!params.has('pgbouncer')) {
    params.set('pgbouncer', 'true');
    mutated = true;
  }
  if (!params.has('connection_limit')) {
    params.set('connection_limit', '1');
    mutated = true;
  }
  if (!mutated) return rawUrl;
  const qs = params.toString();
  return `${base}?${qs}${fragment}`;
}
