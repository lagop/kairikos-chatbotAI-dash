import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeading } from '@/components/portal/PageHeading';
import { ProfileForm } from '@/components/portal/ProfileForm';
import { PasswordChangeForm } from '@/components/portal/PasswordChangeForm';
import { getSession } from '@/lib/session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { DEV_MOCK_CLIENT_BY_EMAIL } from '@/lib/portal-data';
import { resolveClientFromSession } from '@/lib/portal-session';
import { TIER_LABEL } from '@/lib/billing-tier';
import type { ClientProfile } from '@/types/portal';

export const dynamic = 'force-dynamic';

const DATE_FMT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
});

const ONBOARDING_LABEL: Record<string, string> = {
  pending: 'Pendiente',
  'in-progress': 'En curso',
  live: 'En producción',
  paused: 'Pausado',
  cancelled: 'Cancelado',
};

export const metadata: Metadata = {
  title: 'Mi perfil',
  description:
    'Consulta y edita tus datos de contacto en el portal Kairikos y cierra sesión de forma segura.',
  alternates: { canonical: '/portal/perfil' },
  robots: { index: false, follow: false },
  openGraph: {
    title: 'Mi perfil — Portal Kairikos',
    description:
      'Consulta y edita tus datos de contacto en el portal Kairikos y cierra sesión de forma segura.',
    url: '/portal/perfil',
    siteName: 'Kairikos',
    locale: 'es_ES',
    type: 'website',
  },
};

// Bug found 2026-08-21 via manual QA (a real client's /portal/perfil
// showed "no pudimos cargar tus datos" — no profile card, no edit
// form). This function used to gate on `isPortalDevMock()` — a
// Supabase-env-var heuristic that predates this portal's move to
// NextAuth Credentials + Prisma/VPS (the real architecture never sets
// NEXT_PUBLIC_SUPABASE_URL/ANON_KEY at all, so isPortalDevMock() is
// unconditionally true everywhere real, including production) — so
// every real, authenticated client was routed into the
// DEV_MOCK_CLIENT_BY_EMAIL lookup, which has no entry for a real email
// like aurora@example.com and returned null. Same root-cause class as
// the KAIA-11955/WP-25 bugs already fixed in portal-data.ts (getOnboarding,
// listConversations, getBilling): a stale mock-detection gate firing
// before the real session/DB path ever got a chance. Fix: resolve via
// resolveClientFromSession() (the canonical, already-correct resolver —
// tries the real NextAuth session + Prisma first, only falls back to
// mock_dev when there's genuinely no real session), mirroring the
// already-correct GET /api/portal/me.
async function loadProfile(): Promise<ClientProfile | null> {
  const resolved = await resolveClientFromSession();
  if (!resolved) return null;

  if (resolved.source === 'mock_dev' || !isDatabaseConfigured) {
    const mock = DEV_MOCK_CLIENT_BY_EMAIL.get(resolved.email.toLowerCase());
    if (!mock) return null;
    return { ...mock, contactName: mock.companyName };
  }

  try {
    const target = await prisma.chatbotClient.findUnique({
      where: { id: resolved.clientId },
      select: {
        id: true,
        email: true,
        name: true,
        companyName: true,
        tier: true,
        stripeCustomerId: true,
        goLiveAt: true,
        createdAt: true,
      },
    });
    if (!target) return null;

    return {
      id: target.id,
      slug: target.email,
      companyName: target.companyName ?? target.name ?? '',
      primaryContactEmail: target.email,
      stripeCustomerId: target.stripeCustomerId,
      tier: target.tier as ClientProfile['tier'],
      onboardingStatus: target.goLiveAt ? 'live' : 'in-progress',
      createdAt: target.createdAt.toISOString(),
      goLiveDate: target.goLiveAt?.toISOString() ?? null,
      chatbotSpaceId: null,
      contactName: target.name,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[loadProfile] Prisma read failed:', err);
    return null;
  }
}

export default async function ProfilePage() {
  let session;
  try {
    session = await getSession();
  } catch (err) {
    console.error('[portal] /portal/perfil getSession() crashed:', err);
    redirect('/portal/login');
  }

  if (!session.hasClientAccess) {
    const target = session.reason === 'no_session' ? '/portal/login' : '/portal/sin-acceso';
    redirect(target);
  }

  if (!session.email) {
    redirect('/portal/login');
  }

  const profile = await loadProfile();

  if (!profile) {
    return (
      <div className="space-y-6">
        <PageHeading
          eyebrow="Mi perfil"
          title="No hemos podido cargar tus datos"
          description="Vuelve a iniciar sesión y, si el problema continúa, escríbenos."
        />
        <section className="card" aria-label="Acción recomendada">
          <p className="text-sm text-kairikos-muted">
            No hemos encontrado un perfil asociado a tu cuenta en este momento.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <a className="btn-primary" href="/portal/login">
              Volver a iniciar sesión
            </a>
            <a className="btn-ghost" href="/portal/support">
              Contactar soporte
            </a>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Mi perfil"
        title={profile.contactName ?? profile.companyName}
        description="Gestiona tus datos de contacto y tu sesión en el portal Kairikos."
      />

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3" aria-label="Datos de la cuenta">
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Plan</p>
          <p className="mt-1 text-lg font-semibold" data-testid="profile-tier">
            {TIER_LABEL[profile.tier] ?? profile.tier}
          </p>
          <p className="mt-1 text-xs text-kairikos-muted">
            Cliente desde el {DATE_FMT.format(new Date(profile.createdAt))}
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Empresa</p>
          <p className="mt-1 text-lg font-semibold">{profile.companyName || '—'}</p>
          <p className="mt-1 text-xs text-kairikos-muted">
            Estado: {ONBOARDING_LABEL[profile.onboardingStatus] ?? profile.onboardingStatus}
          </p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Chatbot</p>
          <p className="mt-1 text-lg font-semibold">
            {profile.goLiveDate ? 'En producción' : 'Pendiente'}
          </p>
          <p className="mt-1 text-xs text-kairikos-muted">
            {profile.goLiveDate
              ? `Activo desde el ${DATE_FMT.format(new Date(profile.goLiveDate))}`
              : 'Te avisaremos cuando esté listo.'}
          </p>
        </div>
      </section>

      <section className="card" aria-labelledby="profile-form-title">
        <header className="mb-4">
          <h2 id="profile-form-title" className="text-lg font-semibold">
            Tus datos
          </h2>
          <p className="mt-1 text-sm text-kairikos-muted">
            Solo puedes editar tu nombre y tu email de contacto. El resto de los datos los gestiona el
            equipo de Kairikos.
          </p>
        </header>
        <ProfileForm
          initialContactName={profile.contactName ?? ''}
          initialEmail={profile.primaryContactEmail}
        />
      </section>

      <section className="card" aria-labelledby="profile-password-title">
        <header className="mb-4">
          <h2 id="profile-password-title" className="text-lg font-semibold">
            Cambiar contraseña
          </h2>
          <p className="mt-1 text-sm text-kairikos-muted">
            Por seguridad, te pediremos la contraseña actual antes de aceptar una nueva. Al
            cambiarla cerraremos tu sesión para forzar un nuevo inicio.
          </p>
        </header>
        <PasswordChangeForm />
      </section>

      <section className="card" aria-labelledby="profile-session-title">
        <header className="mb-4">
          <h2 id="profile-session-title" className="text-lg font-semibold">
            Sesión
          </h2>
          <p className="mt-1 text-sm text-kairikos-muted">
            Cierra sesión si estás en un dispositivo compartido. Tras hacerlo, no podrás volver a
            entrar sin volver a iniciar sesión.
          </p>
        </header>
        <div className="flex flex-wrap gap-2">
          {/* WP-04 — one logout mechanism for the whole portal: POST
              /api/portal/logout (now clears all 5 session cookies and
              redirects by role). Previously this button called a
              separate logoutAction() server action with its own,
              slightly different cookie-clearing list. */}
          <form action="/api/portal/logout" method="post">
            <button
              type="submit"
              className="btn-ghost w-full justify-center sm:w-auto"
              data-testid="profile-logout"
            >
              Cerrar sesión
            </button>
          </form>
          <a className="btn-ghost w-full justify-center sm:w-auto" href="/portal/support">
            Necesito ayuda
          </a>
        </div>
      </section>
    </div>
  );
}
