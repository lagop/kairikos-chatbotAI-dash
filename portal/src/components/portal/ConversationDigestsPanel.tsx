'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Canales Fase 7 — sección "Resúmenes" de /portal/conversations: timeline
// de ConversationDigest (solo lectura, cada uno expandible vía <details>
// nativo — no hace falta estado por-fila para un simple acordeón) más la
// configuración de horario/frecuencia, que sí es interactiva (PATCH a
// /api/portal/conversation-digests/schedule). Mismo patrón de
// mensaje-de-estado + router.refresh() que GoogleReviewsPanel.
// =============================================================================

export interface ConversationDigestSummary {
  id: string;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  totalConversations: number;
  escalatedCount: number;
  fallbackCount: number;
  summaryText: string;
  highlights: string[];
}

export type DigestPreset = 'morning_noon_evening' | 'custom_interval';

export interface ConversationDigestScheduleConfig {
  enabled: boolean;
  preset: DigestPreset;
  intervalHours: number | null;
  timezone: string;
  lastGeneratedAt: string | null;
}

export interface ConversationDigestsPanelProps {
  digests: ConversationDigestSummary[];
  schedule: ConversationDigestScheduleConfig;
}

const DATE_FMT = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function formatWindow(startIso: string, endIso: string): string {
  return `${DATE_FMT.format(new Date(startIso))} — ${DATE_FMT.format(new Date(endIso))}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'nunca';
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

export function ConversationDigestsPanel({ digests, schedule }: ConversationDigestsPanelProps) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [preset, setPreset] = useState<DigestPreset>(schedule.preset);
  const [intervalHours, setIntervalHours] = useState(schedule.intervalHours ?? 4);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/portal/conversation-digests/schedule', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          preset,
          intervalHours: preset === 'custom_interval' ? intervalHours : null,
          timezone: schedule.timezone,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setMessage({ kind: 'error', text: `No se pudo guardar. ${data?.error ?? res.statusText}` });
        return;
      }
      setMessage({ kind: 'success', text: 'Configuración guardada.' });
      router.refresh();
    } catch (err) {
      setMessage({ kind: 'error', text: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6" data-testid="conversation-digests-section">
      <section className="card space-y-4" aria-label="Configuración de resúmenes" data-testid="digest-schedule-panel">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Resúmenes automáticos</p>
            <p className="text-xs text-kairikos-muted">
              Recibe un resumen de la actividad de tu chatbot en el portal (y por email) cada cierto tiempo.
              {schedule.lastGeneratedAt ? ` · último resumen ${formatRelative(schedule.lastGeneratedAt)}` : ''}
            </p>
          </div>
          <button
            type="button"
            className={enabled ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setEnabled((v) => !v)}
            aria-pressed={enabled}
            data-testid="digest-schedule-toggle"
          >
            {enabled ? 'Activado' : 'Desactivado'}
          </button>
        </div>

        {enabled ? (
          <div className="flex flex-wrap items-end gap-4 border-t border-kairikos-border pt-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-kairikos-muted">Frecuencia</span>
              <select
                className="input"
                value={preset}
                onChange={(e) => setPreset(e.target.value as DigestPreset)}
                data-testid="digest-schedule-preset"
              >
                <option value="morning_noon_evening">Mañana, mediodía y tarde</option>
                <option value="custom_interval">Cada X horas</option>
              </select>
            </label>
            {preset === 'custom_interval' ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs font-medium text-kairikos-muted">Cada cuántas horas</span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  className="input w-24"
                  value={intervalHours}
                  onChange={(e) => setIntervalHours(Number(e.target.value) || 1)}
                  data-testid="digest-schedule-interval"
                />
              </label>
            ) : null}
            <button
              type="button"
              className="btn-primary"
              onClick={save}
              disabled={saving}
              data-testid="digest-schedule-save"
            >
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn-ghost self-start"
            onClick={save}
            disabled={saving}
            data-testid="digest-schedule-save-disabled"
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        )}

        {message ? (
          <div
            role="status"
            data-testid="digest-schedule-message"
            className={
              message.kind === 'success'
                ? 'rounded-xl border border-kairikos-success/40 bg-kairikos-success/10 px-4 py-3 text-sm text-kairikos-success'
                : 'rounded-xl border border-kairikos-danger/40 bg-kairikos-danger/10 px-4 py-3 text-sm text-kairikos-danger'
            }
          >
            {message.text}
          </div>
        ) : null}
      </section>

      {digests.length === 0 ? (
        <p className="text-sm text-kairikos-muted" data-testid="conversation-digests-empty">
          Todavía no se generó ningún resumen. {schedule.enabled ? 'El primero llegará en la próxima franja programada.' : 'Actívalos arriba para empezar a recibirlos.'}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="conversation-digests-list">
          {digests.map((digest) => (
            <li key={digest.id}>
              <details className="card group" data-testid="conversation-digest-item">
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{formatWindow(digest.windowStart, digest.windowEnd)}</p>
                    <p className="text-xs text-kairikos-muted">{digest.summaryText}</p>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <span className="pill-muted" data-testid="digest-total">{digest.totalConversations} conversaciones</span>
                    {digest.escalatedCount > 0 ? (
                      <span className="pill-warning" data-testid="digest-escalated">{digest.escalatedCount} derivadas</span>
                    ) : null}
                  </div>
                </summary>
                <div className="mt-3 space-y-2 border-t border-kairikos-border pt-3">
                  {digest.highlights.length > 0 ? (
                    <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="digest-highlights">
                      {digest.highlights.map((h, i) => (
                        <li key={i}>{h}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-kairikos-muted">Nada que requiera atención en esta ventana.</p>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
