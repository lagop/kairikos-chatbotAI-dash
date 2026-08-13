import type { OnboardingStatus } from '@/types/portal';

// WP-23 — the exhaustive half of the status-vocabulary fix. Unlike
// toOnboardingStatus() (portal-data.ts), which has to accept an unknown
// raw string from the DB and log an anomaly for anything unrecognized,
// these two take an already-typed OnboardingStatus — so a value added to
// the union without a matching case here is a compile error, not a
// silent fallback.

export function onboardingStatusLabel(status: OnboardingStatus): string {
  switch (status) {
    case 'pending':
      return 'Pendiente';
    case 'in-progress':
      return 'En configuración';
    case 'go-live-pending':
      return 'Pidió salir a producción';
    case 'ready':
      return 'Listo, pendiente de aprobar';
    case 'live':
      return 'En producción';
    case 'updating':
      return 'Actualizando';
    case 'paused':
      return 'En pausa';
    case 'cancelled':
      return 'Cancelado';
    case 'archived':
      return 'Archivado';
    case 'draft':
      return 'Borrador';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function onboardingStatusPillClass(status: OnboardingStatus): string {
  switch (status) {
    case 'pending':
      return 'pill-muted';
    case 'in-progress':
      return 'pill-muted';
    case 'go-live-pending':
      return 'pill-warning';
    case 'ready':
      return 'pill-warning';
    case 'live':
      return 'pill-success';
    case 'updating':
      return 'pill-warning';
    case 'paused':
      return 'pill-warning';
    case 'cancelled':
      return 'pill-danger';
    case 'archived':
      return 'pill-danger';
    case 'draft':
      return 'pill-muted';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
