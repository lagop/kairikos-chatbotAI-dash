import Link from 'next/link';
import type { HandoffState } from '@/lib/chatbot-handoff';

// =============================================================================
// Fase 3 — la bandeja de conversaciones que esperan a una persona.
//
// Va arriba del listado de conversaciones, no en una página aparte: una
// conversación derivada ES una conversación, y una bandeja paralela acaba
// divergiendo del listado que ya existe. Lo que la distingue es que aquí
// hay algo que hacer.
//
// Componente de servidor: es una lista de enlaces, no necesita JavaScript.
// Lo interactivo vive en la pantalla de detalle, que es donde se contesta.
// =============================================================================

export interface HandoffInboxRow {
  id: string;
  channel: string | null;
  state: HandoffState;
  requestedAt: string;
  takenBy: string | null;
  lastMessage: string | null;
}

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  messenger: 'Messenger',
  instagram: 'Instagram',
  web: 'Web',
};

const DATE_FMT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** "hace 3 h" dice mejor que una hora exacta lo que importa aquí: cuánto
 *  lleva esperando esta persona. */
function waitingFor(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'ahora mismo';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
}

export function HandoffInbox({ rows, now = new Date() }: { rows: HandoffInboxRow[]; now?: Date }) {
  if (rows.length === 0) {
    return (
      <section className="card space-y-2" aria-label="Conversaciones que esperan a una persona" data-testid="handoff-inbox">
        <p className="text-sm font-semibold">Nadie esperando</p>
        <p className="text-sm text-kairikos-muted">
          Cuando tu bot decida que una conversación necesita a una persona, aparecerá aquí para que la atiendas.
        </p>
      </section>
    );
  }

  const pending = rows.filter((r) => r.state === 'pending').length;

  return (
    <section
      className="card space-y-3"
      aria-label="Conversaciones que esperan a una persona"
      data-testid="handoff-inbox"
    >
      <div>
        <p className="text-sm font-semibold">
          {pending > 0
            ? `${pending} ${pending === 1 ? 'conversación necesita' : 'conversaciones necesitan'} a una persona`
            : 'Conversaciones atendidas por una persona'}
        </p>
        <p className="text-xs text-kairikos-muted">
          Mientras alguien tiene una conversación en la mano, el bot deja de responder en ella.
        </p>
      </div>

      <ul className="space-y-2" data-testid="handoff-inbox-list">
        {rows.map((row) => (
          <li key={row.id} data-testid="handoff-inbox-row" data-state={row.state}>
            <Link
              href={`/portal/conversations/${row.id}`}
              className="block rounded-xl border border-kairikos-border bg-kairikos-surface2 p-3 transition hover:border-kairikos-accent"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className={row.state === 'pending' ? 'pill-warning' : 'pill-muted'}>
                  {row.state === 'pending' ? 'Esperando' : 'La atiende una persona'}
                </span>
                <span className="text-xs text-kairikos-muted">
                  {CHANNEL_LABEL[row.channel ?? ''] ?? 'Otro canal'} · {waitingFor(row.requestedAt, now)}
                </span>
                {row.state === 'taken' && row.takenBy ? (
                  <span className="text-xs text-kairikos-muted">· {row.takenBy}</span>
                ) : null}
              </div>
              {row.lastMessage ? (
                <p className="mt-1.5 line-clamp-2 text-sm text-kairikos-text">{row.lastMessage}</p>
              ) : (
                <p className="mt-1.5 text-sm text-kairikos-muted">
                  Sin mensajes guardados · {DATE_FMT.format(new Date(row.requestedAt))}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
