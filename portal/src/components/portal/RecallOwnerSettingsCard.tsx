'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { downsample, encodeWav, GREETING_SAMPLE_RATE } from '@/lib/wav-audio';

// =============================================================================
// WhatsApp del dueño + locución de la línea de recados. Ver
// lib/recall-owner-settings.ts. La usan el portal del cliente y la ficha del
// operador; solo cambia `endpointBase`.
//
// LA GRABACIÓN SE CONVIERTE A WAV AQUÍ, en el dispositivo (ver
// lib/wav-audio.ts): Twilio no reproduce lo que graba el navegador. Se
// captura con Web Audio (ScriptProcessorNode: obsoleto en la especificación
// pero el único camino sin un fichero de worklet aparte, y lo soportan
// todos los navegadores actuales, iOS incluido).
//
// Límites repetidos a propósito del lado servidor (no se importa ese lib en
// un componente de cliente): 30 s y 1 MB. El servidor vuelve a comprobarlo.
// =============================================================================

const MAX_SECONDS = 30;
const MIN_SECONDS = 2;
const MAX_BYTES = 1_000_000;

export interface RecallOwnerSettingsInitial {
  ownerWhatsapp: string | null;
  businessNumber: string | null;
  status: string;
  greeting: { mimeType: string; sizeBytes: number; recordedAt: string | null } | null;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_number: 'Ese número no parece válido. Escríbelo con prefijo (+34…) o como móvil español de 9 cifras.',
  not_mobile: 'Tiene que ser un móvil con WhatsApp: a un fijo no te llegarían los recados.',
  same_as_business:
    'Tiene que ser un número distinto del WhatsApp del negocio: los recados salen desde ese número y WhatsApp no deja escribirse a uno mismo.',
  too_large: 'El audio pesa demasiado (máximo 1 MB).',
  unsupported_format: 'Formato no admitido. Sube un MP3 o un WAV, o grábalo aquí.',
  corrupt_wav: 'El fichero WAV está dañado.',
  too_short: 'La locución es demasiado corta (mínimo 2 segundos).',
  too_long: 'La locución es demasiado larga (máximo 30 segundos).',
  empty: 'El audio está vacío.',
  not_found: 'No se encontró el servicio.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  operator_session_required: 'Hace falta iniciar sesión como operador.',
  internal_error: 'Algo falló en el servidor. Inténtalo de nuevo.',
};

const DATE = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

type Recording = { blob: Blob; url: string; seconds: number };

export function RecallOwnerSettingsCard({
  endpointBase,
  initial,
  audience,
}: {
  /** '/api/portal/recall' o '/api/admin/portal/recall/<id>' */
  endpointBase: string;
  initial: RecallOwnerSettingsInitial;
  audience: 'client' | 'operator';
}) {
  const router = useRouter();
  const you = audience === 'client';

  // ---- WhatsApp ----------------------------------------------------------
  const [owner, setOwner] = useState(initial.ownerWhatsapp ?? '');
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [ownerMsg, setOwnerMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function saveOwner() {
    setOwnerMsg(null);
    setOwnerBusy(true);
    try {
      const res = await fetch(`${endpointBase}/owner`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerWhatsapp: owner }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setOwnerMsg({ kind: 'error', text: ERROR_LABEL[body.error as string] ?? 'No se pudo guardar.' });
        return;
      }
      setOwner(String(body.ownerWhatsapp ?? owner));
      const fwd = body.forwardingInstructions;
      const extra =
        fwd === 'sent'
          ? ` ${you ? 'Te hemos' : 'Le hemos'} enviado por WhatsApp los códigos para activar el desvío.`
          : fwd === 'failed' || fwd === 'skipped'
            ? ' No se pudieron enviar los códigos de desvío todavía; os avisaremos.'
            : '';
      setOwnerMsg({ kind: 'ok', text: `Guardado.${extra}` });
      router.refresh();
    } catch (err) {
      setOwnerMsg({ kind: 'error', text: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}` });
    } finally {
      setOwnerBusy(false);
    }
  }

  // ---- Locución ----------------------------------------------------------
  const [recording, setRecording] = useState<Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [greetingBusy, setGreetingBusy] = useState(false);
  const [greetingMsg, setGreetingMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [savedVersion, setSavedVersion] = useState(0);
  const capture = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
    node: ScriptProcessorNode;
    chunks: Float32Array[];
    startedAt: number;
    timer: ReturnType<typeof setInterval>;
  } | null>(null);

  useEffect(() => {
    return () => {
      stopCapture(false);
      if (recording) URL.revokeObjectURL(recording.url);
    };
    // Solo al desmontar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startRecording() {
    setGreetingMsg(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setGreetingMsg({ kind: 'error', text: 'Este navegador no permite grabar. Sube un MP3 o un WAV.' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const chunks: Float32Array[] = [];
      node.onaudioprocess = (e) => {
        chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(node);
      node.connect(ctx.destination);
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const secs = (Date.now() - startedAt) / 1000;
        setElapsed(secs);
        if (secs >= MAX_SECONDS) stopCapture(true);
      }, 200);
      capture.current = { ctx, stream, node, chunks, startedAt, timer };
      if (recording) URL.revokeObjectURL(recording.url);
      setRecording(null);
      setElapsed(0);
      setIsRecording(true);
    } catch {
      setGreetingMsg({
        kind: 'error',
        text: 'No hay permiso para usar el micrófono. Actívalo en el navegador o sube un fichero.',
      });
    }
  }

  function stopCapture(keep: boolean) {
    const c = capture.current;
    if (!c) return;
    capture.current = null;
    clearInterval(c.timer);
    c.node.disconnect();
    c.stream.getTracks().forEach((t) => t.stop());
    const sampleRate = c.ctx.sampleRate;
    void c.ctx.close();
    setIsRecording(false);
    if (!keep) return;

    const total = c.chunks.reduce((n, ch) => n + ch.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const ch of c.chunks) {
      merged.set(ch, offset);
      offset += ch.length;
    }
    const seconds = total / sampleRate;
    if (seconds < MIN_SECONDS) {
      setGreetingMsg({ kind: 'error', text: 'Demasiado corta. Graba al menos 2 segundos.' });
      return;
    }
    const clipped = merged.subarray(0, Math.min(merged.length, Math.floor(MAX_SECONDS * sampleRate)));
    const wav = encodeWav(downsample(clipped, sampleRate, GREETING_SAMPLE_RATE), GREETING_SAMPLE_RATE);
    // encodeWav crea su propio ArrayBuffer: nunca es compartido.
    const blob = new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' });
    setRecording({ blob, url: URL.createObjectURL(blob), seconds: Math.min(seconds, MAX_SECONDS) });
  }

  async function upload(blob: Blob, type: string) {
    setGreetingMsg(null);
    if (blob.size > MAX_BYTES) {
      setGreetingMsg({ kind: 'error', text: ERROR_LABEL.too_large });
      return;
    }
    setGreetingBusy(true);
    try {
      const res = await fetch(`${endpointBase}/greeting`, {
        method: 'PUT',
        headers: { 'Content-Type': type },
        body: blob,
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setGreetingMsg({ kind: 'error', text: ERROR_LABEL[body.error as string] ?? 'No se pudo guardar la locución.' });
        return;
      }
      if (recording) URL.revokeObjectURL(recording.url);
      setRecording(null);
      setSavedVersion((v) => v + 1);
      setGreetingMsg({
        kind: 'ok',
        text:
          initial.status === 'active'
            ? 'Locución guardada. La próxima llamada ya la oirá.'
            : 'Locución guardada. Sonará en cuanto el servicio esté activo.',
      });
      router.refresh();
    } catch (err) {
      setGreetingMsg({ kind: 'error', text: `Error de red: ${err instanceof Error ? err.message : 'desconocido'}` });
    } finally {
      setGreetingBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await upload(file, file.type || 'application/octet-stream');
  }

  async function removeGreeting() {
    if (!window.confirm('¿Borrar la locución? Quien llame oirá el mensaje genérico.')) return;
    setGreetingBusy(true);
    setGreetingMsg(null);
    const res = await fetch(`${endpointBase}/greeting`, { method: 'DELETE' }).catch(() => null);
    setGreetingBusy(false);
    if (!res?.ok) {
      setGreetingMsg({ kind: 'error', text: 'No se pudo borrar la locución.' });
      return;
    }
    setGreetingMsg({ kind: 'ok', text: 'Locución borrada. Quien llame oirá el mensaje genérico.' });
    router.refresh();
  }

  const hasSaved = initial.greeting !== null;

  return (
    <section className="card space-y-6 p-5" aria-label="Recados y locución" data-testid="recall-owner-settings">
      {/* ---- WhatsApp ---- */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor="recall-owner-whatsapp" className="text-base font-semibold">
            {you ? 'Tu WhatsApp para recibir los recados' : 'WhatsApp del dueño (recados)'}
          </label>
          {initial.ownerWhatsapp ? (
            <span className="pill-success">Configurado</span>
          ) : (
            <span className="pill-danger" data-testid="recall-owner-missing">
              Falta
            </span>
          )}
        </div>
        <p className="text-sm text-kairikos-muted">
          {you ? 'Aquí te llegan' : 'Aquí le llegan'} los recados de cada llamada perdida, el resumen de las 19:00 y
          los códigos para activar el desvío. Tiene que ser un móvil personal, distinto del WhatsApp del negocio
          {initial.businessNumber ? ` (${initial.businessNumber})` : ''}.
        </p>
        {!initial.ownerWhatsapp && initial.status === 'forwarding_pending' ? (
          <p className="text-sm font-medium text-kairikos-danger">
            El alta está parada aquí: sin este número no se pueden enviar los códigos para activar el desvío.
          </p>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="recall-owner-whatsapp"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className="input sm:max-w-xs"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="+34 600 000 000"
            data-testid="recall-owner-input"
          />
          <button
            type="button"
            className="btn-primary"
            disabled={ownerBusy || !owner.trim()}
            onClick={saveOwner}
            data-testid="recall-owner-save"
          >
            {ownerBusy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
        {ownerMsg ? (
          <p
            role="status"
            className={`text-sm ${ownerMsg.kind === 'ok' ? 'text-kairikos-success' : 'text-kairikos-danger'}`}
            data-testid="recall-owner-message"
          >
            {ownerMsg.text}
          </p>
        ) : null}
      </div>

      <hr className="border-kairikos-border" />

      {/* ---- Locución ---- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Locución de la línea de recados</h3>
          {hasSaved ? <span className="pill-success">Grabada</span> : <span className="pill-warning">Sin grabar</span>}
        </div>
        <p className="text-sm text-kairikos-muted">
          Es lo que oye quien llama y no {you ? 'puedes' : 'puede'} atender. Con {you ? 'tu' : 'su'} propia voz la
          gente deja más mensajes. Si no hay locución, suena un mensaje genérico.
        </p>
        <p className="rounded-xl border border-kairikos-border bg-kairikos-surface2 px-3 py-2 text-sm">
          <span className="font-medium">Ejemplo:</span> «Hola, has llamado a Fontanería Ruiz. Ahora no puedo atenderte.
          Deja tu mensaje después de la señal: mi asistente me lo pasará y te llamo en cuanto pueda.»
          <span className="mt-1 block text-xs text-kairikos-muted">
            Menciona que un asistente toma el recado: quien llama tiene derecho a saberlo.
          </span>
        </p>

        {hasSaved ? (
          <div className="space-y-1" data-testid="recall-greeting-saved">
            <audio
              controls
              preload="none"
              src={`${endpointBase}/greeting?v=${savedVersion}-${initial.greeting?.recordedAt ?? ''}`}
              className="w-full"
            />
            <p className="text-xs text-kairikos-muted">
              {initial.greeting?.recordedAt ? `Guardada el ${DATE.format(new Date(initial.greeting.recordedAt))} · ` : ''}
              {Math.round((initial.greeting?.sizeBytes ?? 0) / 1024)} KB
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {isRecording ? (
            <button type="button" className="btn-primary" onClick={() => stopCapture(true)} data-testid="recall-greeting-stop">
              ■ Parar ({Math.floor(elapsed)} s / {MAX_SECONDS} s)
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={greetingBusy}
              onClick={startRecording}
              data-testid="recall-greeting-record"
            >
              ● {hasSaved || recording ? 'Grabar de nuevo' : 'Grabar'}
            </button>
          )}
          <label className={`btn-ghost cursor-pointer ${greetingBusy || isRecording ? 'pointer-events-none opacity-50' : ''}`}>
            Subir MP3 o WAV
            <input
              type="file"
              accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,.mp3,.wav"
              className="sr-only"
              onChange={onFile}
              data-testid="recall-greeting-file"
            />
          </label>
          {hasSaved && !isRecording ? (
            <button type="button" className="btn-ghost text-kairikos-danger" disabled={greetingBusy} onClick={removeGreeting}>
              Borrar
            </button>
          ) : null}
        </div>

        {recording ? (
          <div className="space-y-2 rounded-xl border border-kairikos-border p-3" data-testid="recall-greeting-preview">
            <p className="text-sm font-medium">Escúchala antes de guardarla ({Math.round(recording.seconds)} s)</p>
            <audio controls src={recording.url} className="w-full" />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary"
                disabled={greetingBusy}
                onClick={() => upload(recording.blob, 'audio/wav')}
                data-testid="recall-greeting-save"
              >
                {greetingBusy ? 'Guardando…' : 'Guardar esta locución'}
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={greetingBusy}
                onClick={() => {
                  URL.revokeObjectURL(recording.url);
                  setRecording(null);
                }}
              >
                Descartar
              </button>
            </div>
          </div>
        ) : null}

        {greetingMsg ? (
          <p
            role="status"
            className={`text-sm ${greetingMsg.kind === 'ok' ? 'text-kairikos-success' : 'text-kairikos-danger'}`}
            data-testid="recall-greeting-message"
          >
            {greetingMsg.text}
          </p>
        ) : null}
      </div>
    </section>
  );
}
