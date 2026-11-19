'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { parseMediaLink, mediaPageUrl, type MediaRef } from '@/lib/cartera/media-link';
import {
  ALQUILER_INCLUDES,
  ALQUILER_TERMS,
  ALQUILER_TYPES,
  ENERGY_LETTERS,
  MAX_MEDIA,
  MEDIA_LABELS,
  VENTA_TAGS,
  VENTA_TYPES,
  ZONES,
  type Option,
} from '@/lib/cartera/form-options';
import { ERROR_TEXT, Field, Notice, ReadOnlyBanner, Section, call, dateTimeText, dayText, errorMessage, priceText, type NoticeMessage } from './cartera-ui';

// =============================================================================
// Cartera — la ficha de una casa (/portal/cartera/<id>), PR 2.
//
// El formulario edita la casa en el formato de la web y la manda entera con
// «Guardar» (PATCH /api/portal/cartera/casas/<id>). Se guarda SIEMPRE, aunque
// falten datos: lo que no valida vuelve en `errors` con las reglas de la web y
// sale arriba; la casa no se publica hasta corregirlo. La referencia, las
// direcciones y el historial de precios los pone el servidor
// (lib/cartera/home-rules.ts); aquí solo se enseñan.
//
// Las fotos van aparte y al momento (subir, ordenar, quitar), porque son
// ficheros; su texto alternativo, en cambio, se guarda con «Guardar», con el
// resto de la ficha, para que «Traducir con IA» pueda proponerlo sin guardar.
// =============================================================================

type Tr = { es: string; en: string; de: string };
type Lang = keyof Tr;
type Alt = { es?: string; en?: string; de?: string };
type HomeError = { path: string; message: string };
type Photo = { id: string; width: number; height: number; bytes: number; alt: Alt };

export interface CarteraHomeEditorData {
  id: string;
  ref: string;
  operation: 'venta' | 'alquiler';
  status: string;
  data: Record<string, unknown>;
  errors: HomeError[];
  slugLocked: boolean;
  published: boolean;
  updatedAt: string;
  photos: Photo[];
  readOnly: boolean;
  graceEndsAt: string | null;
  agents: Array<{ key: string; name: string }>;
  statuses: readonly string[];
  statusLabels: Record<string, string>;
}

const LANGS: Array<{ key: Lang; label: string }> = [
  { key: 'es', label: 'Español' },
  { key: 'en', label: 'Inglés' },
  { key: 'de', label: 'Alemán' },
];
const EMPTY_TR: Tr = { es: '', en: '', de: '' };
const MAX_UPLOAD_BYTES = 3_000_000;
const MAX_SIDE = 2400;
const MAX_PHOTOS = 40;

function asTr(value: unknown): Tr {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Tr>;
  return { es: v.es ?? '', en: v.en ?? '', de: v.de ?? '' };
}
function isEmptyTr(t: Tr) {
  return !t.es.trim() && !t.en.trim() && !t.de.trim();
}
function sameAlt(a: Alt, b: Alt) {
  return (a.es ?? '') === (b.es ?? '') && (a.en ?? '') === (b.en ?? '') && (a.de ?? '') === (b.de ?? '');
}
/** El número de un campo, o undefined si está vacío o no es un número. */
function toNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}
function numText(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/**
 * Reducir la foto en el navegador antes de subirla: como mucho 2.400 px por
 * lado y vuelta a codificar. Al pasar por un canvas se pierden los datos de la
 * cámara, GPS incluido (decisión A de la especificación). Mismo patrón que
 * SiteContentEditor; si sale de más de 3 MB, se baja la calidad.
 */
async function prepareImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no_canvas');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  for (const quality of [0.82, 0.7, 0.6]) {
    // WebP si el navegador sabe hacerlo (Safari devuelve PNG en su lugar); si no, JPEG.
    const webp = await encode('image/webp', quality);
    const blob = webp && webp.type === 'image/webp' ? webp : await encode('image/jpeg', quality);
    if (!blob) throw new Error('no_blob');
    if (blob.size <= MAX_UPLOAD_BYTES) return blob;
  }
  throw new Error('too_large');
}

export function CarteraHomeEditor({ home }: { home: CarteraHomeEditorData }) {
  const router = useRouter();
  const op = home.operation;
  const readOnly = home.readOnly;

  const [data, setData] = useState<Record<string, unknown>>(home.data);
  const [status, setStatus] = useState(home.status);
  const [errors, setErrors] = useState<HomeError[]>(home.errors);
  const [slugLocked, setSlugLocked] = useState(home.slugLocked);
  const [published, setPublished] = useState(home.published);
  const [saved, setSaved] = useState(() => JSON.stringify({ data: home.data, status: home.status }));
  const [photos, setPhotos] = useState<Photo[]>(home.photos);
  const [altDrafts, setAltDrafts] = useState<Record<string, Alt>>(() => Object.fromEntries(home.photos.map((p) => [p.id, p.alt])));

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<NoticeMessage>(null);
  const [translating, setTranslating] = useState(false);
  const [translateMessage, setTranslateMessage] = useState<NoticeMessage>(null);

  const altsDirty = photos.some((p) => !sameAlt(p.alt, altDrafts[p.id] ?? {}));
  const dirty = JSON.stringify({ data, status }) !== saved || altsDirty;

  // Avisar antes de salir con cambios sin guardar.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // --- Editar el estado local -------------------------------------------------
  function set(key: string, value: unknown) {
    setData((prev) => {
      const next = { ...prev };
      if (value === undefined || value === null || value === '') delete next[key];
      else next[key] = value;
      return next;
    });
  }
  const tr = (key: string) => asTr(data[key]);
  function setTr(key: string, lang: Lang, value: string, optional = false) {
    const next = { ...tr(key), [lang]: value };
    set(key, optional && isEmptyTr(next) ? undefined : next);
  }
  const list = (key: string) => (Array.isArray(data[key]) ? (data[key] as string[]) : []);
  function toggle(key: string, value: string, on: boolean) {
    const current = list(key).filter((v) => v !== value);
    set(key, on ? [...current, value] : current);
  }

  const energy = (data.energy && typeof data.energy === 'object' ? data.energy : {}) as Record<string, unknown>;
  function setEnergy(key: string, value: unknown) {
    const next = { ...energy, [key]: value };
    if (value === undefined || value === '') delete next[key];
    set('energy', Object.keys(next).length ? next : undefined);
  }

  const holding = (data.holding && typeof data.holding === 'object' ? data.holding : {}) as Record<string, unknown>;
  function setHolding(key: 'garbage' | 'insurance' | 'upkeep', value: number | undefined) {
    // Los tres van juntos en la web; el que no se rellena es 0 (no hay).
    const next = { garbage: 0, insurance: 0, upkeep: 0, ...holding, [key]: value ?? 0 };
    set('holding', next.garbage === 0 && next.insurance === 0 && next.upkeep === 0 ? undefined : next);
  }

  const months = Array.isArray(data.months) ? (data.months as Array<number | null>) : [null, null];
  function setMonth(i: 0 | 1, value: number | undefined) {
    const next = [...months];
    next[i] = value ?? null;
    set('months', next[0] === null && next[1] === null ? undefined : next);
  }

  const lacks = Array.isArray(data.lacks) ? (data.lacks as unknown[]).map(asTr) : [];
  const setLacks = (next: Tr[]) => set('lacks', next);

  const media = Array.isArray(data.media) ? (data.media as MediaRef[]) : [];
  const [mediaInput, setMediaInput] = useState('');
  const [mediaError, setMediaError] = useState<string | null>(null);
  function addMedia() {
    const parsed = parseMediaLink(mediaInput);
    if (!parsed) {
      setMediaError('No reconozco ese enlace. Pega el de Matterport (con ?m=), YouTube o Vimeo.');
      return;
    }
    if (media.some((m) => m.kind === parsed.kind && m.id === parsed.id)) {
      setMediaError('Ese ya está.');
      return;
    }
    setMediaError(null);
    setMediaInput('');
    set('media', [...media, parsed]);
  }

  // --- Guardar y borrar ---------------------------------------------------------
  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const { ok, data: body } = await call('PATCH', `/api/portal/cartera/casas/${home.id}`, { status, data });
      if (!ok || body.ok !== true) {
        setMessage({ tone: 'error', text: errorMessage(body) });
        return;
      }
      const nextData = body.data as Record<string, unknown>;
      const nextStatus = String(body.status);
      const nextErrors = (body.errors as HomeError[]) ?? [];
      setData(nextData);
      setStatus(nextStatus);
      setErrors(nextErrors);
      setSlugLocked(Boolean(body.slugLocked));
      setSaved(JSON.stringify({ data: nextData, status: nextStatus }));
      if (nextStatus !== 'borrador' && nextErrors.length === 0) setPublished(true);

      // El texto alternativo de las fotos que cambió.
      let altFailed = false;
      for (const p of photos) {
        const draft = altDrafts[p.id] ?? {};
        if (sameAlt(p.alt, draft)) continue;
        const r = await call('PATCH', `/api/portal/cartera/casas/${home.id}/fotos`, { photoId: p.id, alt: draft });
        if (r.ok && r.data.ok === true) {
          const clean = r.data.alt as Alt;
          setPhotos((all) => all.map((x) => (x.id === p.id ? { ...x, alt: clean } : x)));
          setAltDrafts((all) => ({ ...all, [p.id]: clean }));
        } else altFailed = true;
      }

      if (altFailed) setMessage({ tone: 'error', text: 'La ficha se ha guardado, pero el texto de alguna foto no. Vuelve a guardar.' });
      else if (nextErrors.length > 0) setMessage({ tone: 'ok', text: 'Guardado. Todavía no se publica: corrige los avisos de arriba.' });
      else if (nextStatus === 'borrador') setMessage({ tone: 'ok', text: 'Guardado como borrador. Cuando quieras publicarla, cambia el estado.' });
      else setMessage({ tone: 'ok', text: 'Guardado. Tu web se actualizará sola en unos minutos.' });
    } catch {
      setMessage({ tone: 'error', text: 'Sin conexión. Inténtalo de nuevo.' });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`¿Borrar el borrador ${home.ref}? Se borran también sus fotos. No se puede deshacer.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const { ok, data: body } = await call('DELETE', `/api/portal/cartera/casas/${home.id}`);
      if (!ok) {
        setMessage({ tone: 'error', text: errorMessage(body) });
        return;
      }
      setSaved(JSON.stringify({ data, status }));
      router.push('/portal/cartera');
      router.refresh();
    } catch {
      setMessage({ tone: 'error', text: 'Sin conexión. Inténtalo de nuevo.' });
    } finally {
      setBusy(false);
    }
  }

  // --- Traducir con IA (decisión B: propone, nunca guarda) ----------------------
  async function translate() {
    setTranslating(true);
    setTranslateMessage(null);
    try {
      const input = {
        title: tr('title').es,
        summary: tr('summary').es,
        floor: tr('floor').es,
        lacks: lacks.map((l) => l.es),
        alts: photos.map((p) => ({ id: p.id, text: altDrafts[p.id]?.es ?? '' })).filter((a) => a.text.trim()),
      };
      const { ok, data: body } = await call('POST', `/api/portal/cartera/casas/${home.id}/traducir`, input);
      if (!ok || body.ok !== true) {
        setTranslateMessage({ tone: 'error', text: errorMessage(body) });
        return;
      }
      type EnDe = { en: string; de: string };
      const p = body.proposal as { title: EnDe | null; summary: EnDe | null; floor: EnDe | null; lacks: Array<EnDe | null>; alts: Array<{ id: string } & EnDe> };
      setData((prev) => {
        const next = { ...prev };
        for (const key of ['title', 'summary', 'floor'] as const) {
          const proposal = p[key];
          if (proposal) next[key] = { ...asTr(prev[key]), ...proposal };
        }
        if (Array.isArray(prev.lacks)) {
          next.lacks = (prev.lacks as unknown[]).map((l, i) => (p.lacks[i] ? { ...asTr(l), ...p.lacks[i] } : asTr(l)));
        }
        return next;
      });
      setAltDrafts((prev) => {
        const next = { ...prev };
        for (const a of p.alts) next[a.id] = { ...(prev[a.id] ?? {}), en: a.en, de: a.de };
        return next;
      });
      setTranslateMessage({ tone: 'ok', text: 'Propuesta puesta en inglés y alemán. Revísala y pulsa «Guardar»: no se ha guardado nada.' });
    } catch {
      setTranslateMessage({ tone: 'error', text: 'Sin conexión. Inténtalo de nuevo.' });
    } finally {
      setTranslating(false);
    }
  }

  const statusOptions = home.statuses.filter((s) => !(published && s === 'borrador'));
  const canDelete = status === 'borrador' && !published && !readOnly;
  const slugs = asTr(data.slugs);
  const priceHistory = Array.isArray(data.priceHistory) ? (data.priceHistory as Array<{ date: string; price: number }>) : [];
  const typeOptions = op === 'venta' ? VENTA_TYPES : ALQUILER_TYPES;
  const publishable = status !== 'borrador' && errors.length === 0;

  return (
    <div className="pb-24">
      <p className="text-sm">
        <Link href="/portal/cartera" className="text-kairikos-muted hover:underline">
          ← Todas las casas
        </Link>
      </p>
      {readOnly ? <ReadOnlyBanner graceEndsAt={home.graceEndsAt} /> : null}

      <div className="card mt-4 text-sm" data-testid="cartera-home-state">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-mono">{home.ref}</span>
          <span className="pill-muted">{op === 'venta' ? 'Venta' : 'Alquiler'}</span>
          <span className={status === 'borrador' ? 'pill-muted' : publishable ? 'pill-success' : 'pill-warning'}>{home.statusLabels[status] ?? status}</span>
          <span className="text-kairikos-muted">
            {publishable ? 'Sale en tu web.' : status === 'borrador' ? 'Borrador: no sale en tu web.' : 'No sale en tu web hasta corregir los avisos.'}
          </span>
        </p>
        {errors.length > 0 ? (
          <div className="mt-3" data-testid="cartera-home-errors">
            <p className="font-semibold text-kairikos-warning">{status === 'borrador' ? 'Lo que falta para poder publicarla:' : 'Lo que impide publicarla:'}</p>
            <ul className="mt-1 list-disc pl-5">
              {errors.map((e, i) => (
                <li key={`${e.path}-${i}`}>{e.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <fieldset disabled={readOnly} className="min-w-0">
        <Section title="Lo básico" description="La referencia la pone el portal y no cambia nunca. Una casa publicada no vuelve a borrador: se retira con su estado.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Estado">
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="cartera-status">
                {statusOptions.map((s) => (
                  <option key={s} value={s}>
                    {home.statusLabels[s] ?? s}
                  </option>
                ))}
              </select>
            </Field>
            <SelectField label="Tipo" value={String(data.type ?? '')} options={typeOptions} onChange={(v) => set('type', v)} />
            <SelectField label="Zona" value={String(data.zone ?? '')} options={ZONES} onChange={(v) => set('zone', v)} />
            {op === 'venta' ? (
              <Field label="Precio (€)">
                <NumberInput value={data.price} onChange={(v) => set('price', v)} />
              </Field>
            ) : (
              <Field label="Renta mensual (€)">
                <NumberInput value={data.rent} onChange={(v) => set('rent', v)} />
              </Field>
            )}
            <Field label="Fecha de alta">
              <input className="input" type="date" value={String(data.listedAt ?? '')} onChange={(e) => set('listedAt', e.target.value)} />
            </Field>
            {home.agents.length > 0 ? (
              <SelectField label="Agente" value={String(data.agent ?? '')} options={home.agents.map((a) => ({ value: a.key, label: a.name }))} onChange={(v) => set('agent', v)} />
            ) : (
              <Field label="Agente" hint="Tu agencia aún no tiene agentes dados de alta: pídeselo a soporte.">
                <input className="input" value={String(data.agent ?? '')} onChange={(e) => set('agent', e.target.value)} />
              </Field>
            )}
          </div>
          {op === 'venta' ? (
            <Check label="Destacada en la portada" checked={data.featured === true} onChange={(v) => set('featured', v)} />
          ) : null}
        </Section>

        {op === 'alquiler' ? (
          <Section title="Condiciones del alquiler" description="Larga duración es vivienda habitual (LAU, contrato de un año prorrogable). Temporada, de 32 días a 12 meses, con la causa en el contrato. Nunca turístico.">
            <div className="grid gap-4 sm:grid-cols-3">
              <SelectField
                label="Duración"
                value={String(data.term ?? '')}
                options={ALQUILER_TERMS}
                onChange={(v) => {
                  set('term', v);
                  if (v === 'larga') set('months', undefined);
                }}
              />
              <Field label="Disponible desde">
                <input className="input" type="date" value={String(data.availableFrom ?? '')} onChange={(e) => set('availableFrom', e.target.value)} />
              </Field>
              <Field label="Garantía adicional (mensualidades)" hint="Además de la fianza. Hasta 2 en larga duración y 1 en temporada.">
                <select className="input" value={numText(data.guarantee) || '0'} onChange={(e) => set('guarantee', Number(e.target.value))}>
                  {[0, 1, 2].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
              {data.term === 'temporada' ? (
                <>
                  <Field label="Estancia mínima (meses)">
                    <NumberInput value={months[0]} onChange={(v) => setMonth(0, v)} />
                  </Field>
                  <Field label="Estancia máxima (meses)">
                    <NumberInput value={months[1]} onChange={(v) => setMonth(1, v)} />
                  </Field>
                </>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Check label="Amueblada" checked={data.furnished === true} onChange={(v) => set('furnished', v)} />
              <Check label="Admite mascotas" checked={data.pets === true} onChange={(v) => set('pets', v)} />
            </div>
            <div>
              <p className="label">Incluido en la renta</p>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {ALQUILER_INCLUDES.map((o) => (
                  <Check key={o.value} label={o.label} checked={list('includes').includes(o.value)} onChange={(v) => toggle('includes', o.value, v)} />
                ))}
              </div>
            </div>
          </Section>
        ) : null}

        <Section title="Superficies y distribución">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Superficie útil (m²)">
              <NumberInput value={data.usable} onChange={(v) => set('usable', v)} />
            </Field>
            <Field label="Superficie construida (m²)">
              <NumberInput value={data.built} onChange={(v) => set('built', v)} />
            </Field>
            <Field label="Parcela (m²)" hint="Vacío si no tiene.">
              <NumberInput value={data.plot} onChange={(v) => set('plot', v)} />
            </Field>
            <Field label="Dormitorios">
              <NumberInput value={data.bedrooms} onChange={(v) => set('bedrooms', v)} />
            </Field>
            <Field label="Baños">
              <NumberInput value={data.bathrooms} onChange={(v) => set('bathrooms', v)} />
            </Field>
            <Field label="Aseos">
              <NumberInput value={data.toilets} onChange={(v) => set('toilets', v)} />
            </Field>
            <Field label="Año de construcción">
              <NumberInput value={data.yearBuilt} onChange={(v) => set('yearBuilt', v)} />
            </Field>
            {op === 'venta' ? (
              <Field label="Año de la última reforma">
                <NumberInput value={data.yearRenovated} onChange={(v) => set('yearRenovated', v)} />
              </Field>
            ) : null}
          </div>
          <TrInputs label="Planta" hint="Por ejemplo «Segunda planta con ascensor». Vacío si es una casa." value={tr('floor')} onChange={(lang, v) => setTr('floor', lang, v, true)} />
        </Section>

        <Section
          title="Certificado energético"
          description={
            op === 'venta'
              ? 'Obligatorio para publicar (RD 390/2021, art. 15). Solo una parcela puede ir sin él.'
              : 'Obligatorio en todo anuncio de alquiler (RD 390/2021, art. 15).'
          }
        >
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Consumo (letra)">
              <LetterSelect value={energy.consumo} onChange={(v) => setEnergy('consumo', v)} />
            </Field>
            <Field label="Consumo (kWh/m² año)">
              <NumberInput value={energy.kwh} onChange={(v) => setEnergy('kwh', v)} />
            </Field>
            <Field label="Emisiones (letra)">
              <LetterSelect value={energy.emisiones} onChange={(v) => setEnergy('emisiones', v)} />
            </Field>
            <Field label="Emisiones (kg CO₂/m² año)">
              <NumberInput value={energy.co2} onChange={(v) => setEnergy('co2', v)} />
            </Field>
          </div>
        </Section>

        {op === 'venta' ? (
          <>
            <Section title="Lo que cuesta tenerla" description="Se enseña en la ficha para que el comprador sepa lo que paga al año. 0 o vacío si no hay.">
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Comunidad (€/mes)">
                  <NumberInput value={data.community} onChange={(v) => set('community', v)} />
                </Field>
                <Field label="IBI (€/año)">
                  <NumberInput value={data.ibi} onChange={(v) => set('ibi', v)} />
                </Field>
                <Field label="Basura (€/año)">
                  <NumberInput value={holding.garbage} onChange={(v) => setHolding('garbage', v)} />
                </Field>
                <Field label="Seguro (€/año)">
                  <NumberInput value={holding.insurance} onChange={(v) => setHolding('insurance', v)} />
                </Field>
                <Field label="Jardín y piscina (€/mes)">
                  <NumberInput value={holding.upkeep} onChange={(v) => setHolding('upkeep', v)} />
                </Field>
              </div>
            </Section>

            <Section title="Licencia turística y etiquetas">
              <Check label="Tiene licencia de vivienda turística" checked={data.touristLicence === true} onChange={(v) => set('touristLicence', v)} />
              <div>
                <p className="label">Etiquetas (definen las colecciones de la web)</p>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {VENTA_TAGS.map((o) => (
                    <Check key={o.value} label={o.label} checked={list('tags').includes(o.value)} onChange={(v) => toggle('tags', o.value, v)} />
                  ))}
                </div>
              </div>
            </Section>
          </>
        ) : null}

        <Section title="Textos" description="En español, inglés y alemán. Escribe el español y pulsa «Traducir con IA»: propone los otros dos, tú los revisas y guardas.">
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-ghost" onClick={translate} disabled={translating || readOnly} data-testid="cartera-translate">
              {translating ? 'Traduciendo…' : 'Traducir con IA'}
            </button>
            <Notice message={translateMessage} />
          </div>
          <TrInputs label="Título" value={tr('title')} onChange={(lang, v) => setTr('title', lang, v)} />
          <TrInputs label="Resumen" multiline value={tr('summary')} onChange={(lang, v) => setTr('summary', lang, v)} />
          <div>
            <p className="label">Lo que no tiene</p>
            <p className="text-xs text-kairikos-muted">Opcional. Decirlo antes ahorra visitas que no van a ninguna parte (por ejemplo «Sin ascensor»).</p>
            <div className="mt-2 space-y-3">
              {lacks.map((l, i) => (
                <div key={i} className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <TrInputs label={`Punto ${i + 1}`} value={l} onChange={(lang, v) => setLacks(lacks.map((x, j) => (j === i ? { ...x, [lang]: v } : x)))} />
                  </div>
                  <button type="button" className="btn-ghost mt-6" onClick={() => setLacks(lacks.filter((_, j) => j !== i))}>
                    Quitar
                  </button>
                </div>
              ))}
              <button type="button" className="btn-ghost" onClick={() => setLacks([...lacks, { ...EMPTY_TR }])}>
                Añadir punto
              </button>
            </div>
          </div>
          <div className="text-sm">
            <p className="label">Dirección de la ficha</p>
            <p className="text-xs text-kairikos-muted">
              {slugLocked ? 'Fija desde que se publicó: cambiarla rompería los enlaces.' : 'Sale del título al guardar y se fija cuando la casa se publica por primera vez.'}
            </p>
            <ul className="mt-1 font-mono text-xs">
              {LANGS.map((l) => (
                <li key={l.key}>
                  {l.key}: {slugs[l.key] || '—'}
                </li>
              ))}
            </ul>
          </div>
        </Section>

        <Section title="Vídeo y recorrido" description="Pega el enlace de Matterport, YouTube o Vimeo. Se guarda solo el identificador: la web monta el reproductor. Hasta tres.">
          {media.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {media.map((m, i) => (
                <li key={`${m.kind}-${m.id}`} className="flex flex-wrap items-center gap-3">
                  <span>{MEDIA_LABELS[m.kind] ?? m.kind}</span>
                  <a href={mediaPageUrl(m)} target="_blank" rel="noreferrer noopener" className="font-mono text-xs underline">
                    {m.id}
                  </a>
                  <button type="button" className="btn-ghost" onClick={() => set('media', media.filter((_, j) => j !== i))}>
                    Quitar
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {media.length < MAX_MEDIA ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Enlace">
                <input
                  className="input w-80 max-w-full"
                  value={mediaInput}
                  placeholder="https://my.matterport.com/show/?m=…"
                  onChange={(e) => {
                    setMediaInput(e.target.value);
                    setMediaError(null);
                  }}
                />
              </Field>
              <button type="button" className="btn-ghost" onClick={addMedia} disabled={!mediaInput.trim()}>
                Añadir
              </button>
            </div>
          ) : null}
          {mediaError ? <p className="text-sm text-kairikos-danger">{mediaError}</p> : null}
        </Section>
      </fieldset>

      <PhotosSection
        homeId={home.id}
        readOnly={readOnly}
        photos={photos}
        setPhotos={setPhotos}
        altDrafts={altDrafts}
        setAltDrafts={setAltDrafts}
      />

      <fieldset disabled={readOnly} className="min-w-0">
        {op === 'venta' ? (
          <Section
            title="Historial de precios"
            description="El portal apunta solo cada cambio de precio desde que la casa se publica. Tú decides si se enseña en la ficha: háblalo antes con el vendedor."
          >
            {priceHistory.length > 0 ? (
              <ul className="text-sm">
                {priceHistory.map((h, i) => (
                  <li key={`${h.date}-${i}`}>
                    {dayText(h.date)}: {priceText('venta', h.price)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-kairikos-muted">Sin cambios de precio todavía.</p>
            )}
            <Check label="Enseñar el historial en la ficha" checked={data.showHistory === true} onChange={(v) => set('showHistory', v)} />
          </Section>
        ) : null}
      </fieldset>

      <Section title="A escala">
        <p className="max-w-2xl text-sm text-kairikos-muted">
          La ficha «a escala» (plano con medidas y, en venta, «Si la reformas») la prepara Kairikos aparte a partir de tus planos; no se edita aquí. Si quieres
          una para esta casa, pídela a soporte con la referencia {home.ref}.
        </p>
      </Section>

      <div className="sticky bottom-0 z-10 mt-10 border-t border-kairikos-border bg-kairikos-bg/95 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-3">
          {!readOnly ? (
            <button type="button" className="btn-primary" onClick={save} disabled={busy || !dirty} data-testid="cartera-save">
              {busy ? 'Guardando…' : 'Guardar'}
            </button>
          ) : null}
          {dirty && !readOnly ? <span className="text-sm text-kairikos-muted">Hay cambios sin guardar.</span> : null}
          <Notice message={message} />
          {canDelete ? (
            <button type="button" className="btn-ghost ml-auto text-kairikos-danger" onClick={remove} disabled={busy} data-testid="cartera-delete">
              Borrar borrador
            </button>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-kairikos-muted">Última edición guardada: {dateTimeText(home.updatedAt)}</p>
      </div>
    </div>
  );
}

// --- Campos ----------------------------------------------------------------------

function NumberInput({ value, onChange }: { value: unknown; onChange: (v: number | undefined) => void }) {
  // El texto tal como se escribe: «12,» o «0.» todavía no son el número que
  // se quiere. Solo se reescribe cuando el valor cambia desde fuera (al guardar).
  const [text, setText] = useState(numText(value));
  useEffect(() => {
    setText((current) => (toNumber(current) === value ? current : numText(value)));
  }, [value]);
  return (
    <input
      className="input"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(toNumber(e.target.value));
      }}
    />
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: Option[]; onChange: (v: string | undefined) => void }) {
  return (
    <Field label={label}>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function LetterSelect({ value, onChange }: { value: unknown; onChange: (v: string | undefined) => void }) {
  return (
    <select className="input" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">—</option>
      {ENERGY_LETTERS.map((l) => (
        <option key={l} value={l}>
          {l}
        </option>
      ))}
    </select>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function TrInputs({ label, hint, value, onChange, multiline = false }: { label: string; hint?: string; value: Tr; onChange: (lang: Lang, v: string) => void; multiline?: boolean }) {
  return (
    <div>
      <p className="label">{label}</p>
      {hint ? <p className="text-xs text-kairikos-muted">{hint}</p> : null}
      <div className={`mt-1 grid gap-2 ${multiline ? '' : 'sm:grid-cols-3'}`}>
        {LANGS.map((l) =>
          multiline ? (
            <label key={l.key} className="block text-xs text-kairikos-muted">
              {l.label}
              <textarea className="input mt-1 min-h-24" value={value[l.key]} onChange={(e) => onChange(l.key, e.target.value)} />
            </label>
          ) : (
            <label key={l.key} className="block text-xs text-kairikos-muted">
              {l.label}
              <input className="input mt-1" value={value[l.key]} onChange={(e) => onChange(l.key, e.target.value)} />
            </label>
          ),
        )}
      </div>
    </div>
  );
}

// --- Fotos -----------------------------------------------------------------------

function PhotosSection({
  homeId,
  readOnly,
  photos,
  setPhotos,
  altDrafts,
  setAltDrafts,
}: {
  homeId: string;
  readOnly: boolean;
  photos: Photo[];
  setPhotos: (fn: (all: Photo[]) => Photo[]) => void;
  altDrafts: Record<string, Alt>;
  setAltDrafts: (fn: (all: Record<string, Alt>) => Record<string, Alt>) => void;
}) {
  const [uploading, setUploading] = useState<string | null>(null);
  const [message, setMessage] = useState<NoticeMessage>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const base = `/api/portal/cartera/casas/${homeId}/fotos`;
  const free = MAX_PHOTOS - photos.length;
  const totalMb = useMemo(() => photos.reduce((s, p) => s + p.bytes, 0) / 1_000_000, [photos]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setMessage(null);
    const chosen = Array.from(files).slice(0, Math.max(0, free));
    let failed = 0;
    let lastError = '';
    for (const [i, file] of chosen.entries()) {
      setUploading(`Subiendo ${i + 1} de ${chosen.length}…`);
      let blob: Blob;
      try {
        blob = await prepareImage(file);
      } catch (err) {
        failed++;
        lastError = err instanceof Error && err.message === 'too_large' ? ERROR_TEXT.too_large : ERROR_TEXT.unreadable;
        continue;
      }
      const form = new FormData();
      form.append('archivo', blob, `foto.${blob.type.split('/')[1] ?? 'jpg'}`);
      const res = await fetch(base, { method: 'POST', body: form }).catch(() => null);
      const body = ((await res?.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      if (!res?.ok || body.ok !== true) {
        failed++;
        lastError = errorMessage(body);
        if (body.error === 'too_many_photos' || body.error === 'read_only') break;
        continue;
      }
      const p = body.photo as { id: string; width: number; height: number; bytes: number };
      setPhotos((all) => [...all, { id: p.id, width: p.width, height: p.height, bytes: p.bytes, alt: {} }]);
      setAltDrafts((all) => ({ ...all, [p.id]: {} }));
    }
    setUploading(null);
    if (inputRef.current) inputRef.current.value = '';
    const skipped = files.length - chosen.length;
    if (failed > 0) setMessage({ tone: 'error', text: `${failed === 1 ? 'Una foto no se ha subido' : `${failed} fotos no se han subido`}: ${lastError}` });
    else if (skipped > 0) setMessage({ tone: 'error', text: `Se han subido ${chosen.length}; las otras ${skipped} no caben (como mucho ${MAX_PHOTOS} por casa).` });
    else setMessage({ tone: 'ok', text: chosen.length === 1 ? 'Foto subida.' : `${chosen.length} fotos subidas.` });
  }

  async function reorder(from: number, to: number) {
    if (from === to || to < 0 || to >= photos.length) return;
    const before = photos;
    const next = [...photos];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setPhotos(() => next);
    setMessage(null);
    const { ok, data } = await call('PATCH', base, { order: next.map((p) => p.id) }).catch(() => ({ ok: false, data: {} as Record<string, unknown> }));
    if (!ok) {
      setPhotos(() => before);
      setMessage({ tone: 'error', text: errorMessage(data) });
    }
  }

  async function remove(photo: Photo) {
    if (!window.confirm('¿Quitar esta foto? No se puede deshacer.')) return;
    setMessage(null);
    const { ok, data } = await call('DELETE', base, { photoId: photo.id }).catch(() => ({ ok: false, data: {} as Record<string, unknown> }));
    if (!ok) {
      setMessage({ tone: 'error', text: errorMessage(data) });
      return;
    }
    setPhotos((all) => all.filter((p) => p.id !== photo.id));
    setMessage({ tone: 'ok', text: 'Foto quitada.' });
  }

  return (
    <Section
      title="Fotos"
      description={`La primera es la portada; arrástralas para cambiar el orden. Se reducen en tu navegador a ${MAX_SIDE} px y se les quitan los datos de la cámara (GPS incluido) antes de subirlas. Hasta ${MAX_PHOTOS}.`}
    >
      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="hidden"
            onChange={(e) => upload(e.target.files)}
            data-testid="cartera-photo-input"
          />
          <button type="button" className="btn-ghost" disabled={uploading !== null || free <= 0} onClick={() => inputRef.current?.click()}>
            Subir fotos
          </button>
          <span className="text-sm text-kairikos-muted">
            {uploading ?? `${photos.length} de ${MAX_PHOTOS} · ${totalMb.toFixed(1).replace('.', ',')} MB`}
          </span>
        </div>
      ) : null}
      <Notice message={message} />
      {photos.length === 0 ? (
        <p className="text-sm text-kairikos-muted">Todavía no hay fotos.</p>
      ) : (
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="cartera-photos">
          {photos.map((p, i) => {
            const draft = altDrafts[p.id] ?? {};
            return (
              <li
                key={p.id}
                className={`card space-y-2 p-3 ${dragFrom === i ? 'opacity-50' : ''}`}
                draggable={!readOnly}
                onDragStart={() => setDragFrom(i)}
                onDragEnd={() => setDragFrom(null)}
                onDragOver={(e) => {
                  if (dragFrom !== null) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragFrom !== null) void reorder(dragFrom, i);
                  setDragFrom(null);
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- la sirve el portal con sesión; next/image no aporta aquí */}
                <img src={`${base}/${p.id}`} alt={draft.es ?? ''} width={p.width} height={p.height} loading="lazy" className="aspect-[4/3] w-full rounded object-cover" />
                <p className="flex items-center justify-between text-xs text-kairikos-muted">
                  <span>
                    {i === 0 ? 'Portada · ' : `${i + 1} · `}
                    {p.width}×{p.height}
                  </span>
                  {!readOnly ? (
                    <span className="flex gap-1">
                      <button type="button" className="btn-ghost px-2 py-0.5" aria-label="Mover antes" disabled={i === 0} onClick={() => reorder(i, i - 1)}>
                        ←
                      </button>
                      <button type="button" className="btn-ghost px-2 py-0.5" aria-label="Mover después" disabled={i === photos.length - 1} onClick={() => reorder(i, i + 1)}>
                        →
                      </button>
                      <button type="button" className="btn-ghost px-2 py-0.5 text-kairikos-danger" onClick={() => remove(p)}>
                        Quitar
                      </button>
                    </span>
                  ) : null}
                </p>
                <fieldset disabled={readOnly} className="space-y-1">
                  {LANGS.map((l) => (
                    <label key={l.key} className="block text-xs text-kairikos-muted">
                      Texto alternativo ({l.label.toLowerCase()})
                      <input
                        className="input mt-0.5"
                        maxLength={300}
                        value={draft[l.key] ?? ''}
                        onChange={(e) => setAltDrafts((all) => ({ ...all, [p.id]: { ...(all[p.id] ?? {}), [l.key]: e.target.value } }))}
                      />
                    </label>
                  ))}
                </fieldset>
              </li>
            );
          })}
        </ol>
      )}
      {photos.some((p) => !sameAlt(p.alt, altDrafts[p.id] ?? {})) ? <p className="text-xs text-kairikos-muted">Los textos de las fotos se guardan con «Guardar».</p> : null}
    </Section>
  );
}

