import { SkeletonList } from '@/components/portal/Skeleton';

// WP-08 — getDashboardData() does two Prisma round-trips plus, on the
// fallback path, an extra fetch to /api/portal/me — perceptibly slower
// than the rest of the portal's single-query pages. Next.js swaps this in
// automatically while the page's async work is in flight.
export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      <SkeletonList count={1} height={72} />
      <SkeletonList count={2} height={140} />
    </div>
  );
}
