'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  buildSteps,
  compute,
  fmt,
  insightFor,
  priceText,
  QUOTER_CALL_SLOTS,
  QUOTER_CONSENT,
  type QuoterAnswers,
  type QuoterData,
} from '@/lib/premium-quoter-engine';
import { QUOTER_ICONS } from '@/lib/premium-quoter-icons';
import styles from './PremiumQuoter.module.css';

// =============================================================================
// Presupuestador de Kairikos Web Premium — la pantalla (09/11/2026).
//
// Traducción a React de renderStep/renderSummary/renderResult del prototipo,
// con sus textos. Los datos llegan del servidor con los importes ya puestos;
// aquí solo se decide qué pintar.
//
// El estado se guarda también en una referencia: tras elegir una opción se
// avanza con un setTimeout, y ese temporizador tiene que ver la respuesta
// recién elegida, no la de cuando se creó el cierre.
//
// La analítica no sale de aquí. Quien inserta el presupuestador pasa onEvent:
// en kairikos.com es window.kairikosEvento, que solo manda a GA4 si el
// visitante aceptó las cookies. En /web-premium del portal no se manda nada: es
// otro dominio, sin aviso de cookies propio. Nunca llevan datos de la persona.
//
// 10/11/2026 — dentro de kairikos.com va insertado en la página (src/embed/),
// no en un marco: el marco tenía su propio scroll dentro del de la página. Por
// eso las distancias que dependen de la página de alrededor (la cabecera fija,
// los botones flotantes) se leen de variables CSS que pone quien lo inserta.
// =============================================================================

const cx = (...names: (string | false | undefined)[]) =>
  names
    .filter((n): n is string => Boolean(n))
    .map((n) => styles[n])
    .join(' ');

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: QUOTER_ICONS[name] ?? '' }} />
  );
}

function Check({ size }: { size?: number }) {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2} width={size} height={size}>
      <path d="M2.5 6.2 5 8.5l4.5-5" />
    </svg>
  );
}

/** Los textos editables solo admiten <em> y <b>. Lo demás se pinta como texto. */
function Rich({ text }: { text: string }): ReactNode {
  return text.split(/(<em>.*?<\/em>|<b>.*?<\/b>)/).map((part, i) => {
    const em = part.match(/^<em>(.*)<\/em>$/);
    if (em) return <em key={i}>{em[1]}</em>;
    const b = part.match(/^<b>(.*)<\/b>$/);
    if (b) return <b key={i}>{b[1]}</b>;
    return part;
  });
}

/** Avisa a la analítica de quien lo inserta. Nunca lleva datos de la persona. */
export type QuoterEventSink = (evento: string, datos: Record<string, string | number>) => void;

const DEFAULT_SUBMIT_URL = '/api/public/presupuestador';

interface State {
  sector: string | null;
  step: number;
  answers: QuoterAnswers;
  showResult: boolean;
}

export function PremiumQuoter({
  quoter,
  embedded,
  preview,
  onEvent,
  submitUrl = DEFAULT_SUBMIT_URL,
}: {
  quoter: QuoterData;
  embedded: boolean;
  preview: boolean;
  onEvent?: QuoterEventSink;
  submitUrl?: string;
}) {
  const { config, sectors, baseSteps } = quoter;
  const emit = useCallback<QuoterEventSink>((evento, datos) => onEvent?.(evento, datos), [onEvent]);
  const [state, setState] = useState<State>({ sector: null, step: 0, answers: {}, showResult: false });
  const stateRef = useRef(state);
  const commit = useCallback((next: State) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const steps = useMemo(() => buildSteps(quoter, state.sector), [quoter, state.sector]);
  const sec = state.sector ? sectors[state.sector] : undefined;
  const selection = { sector: state.sector, answers: state.answers };
  const r = compute(quoter, selection);

  const wrapRef = useRef<HTMLElement>(null);

  // --- enlaces directos por sector: …#dental, #estetica, #inmobiliaria… --------
  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.slice(1);
      const current = stateRef.current;
      const known = Object.prototype.hasOwnProperty.call(sectors, id);
      if (known && current.sector !== id) {
        commit({ sector: id, answers: { sector: id }, step: 1, showResult: false });
        emit('presupuestador_sector', { sector: id });
      } else if (!known && !current.sector && current.step !== 0) {
        commit({ ...current, step: 0 });
      }
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [sectors, commit, emit]);

  // --- el titular se funde al cambiar de sector ---------------------------------
  const target = sec ? sec.hero : config.defaultHero;
  const [hero, setHero] = useState(target);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (hero.h1 === target.h1) return;
    setFading(true);
    const t = setTimeout(() => {
      setHero(target);
      setFading(false);
    }, 220);
    return () => clearTimeout(t);
  }, [target, hero.h1]);

  // --- el importe cuenta hasta su valor -----------------------------------------
  const [shown, setShown] = useState(0);
  const shownRef = useRef(0);
  useEffect(() => {
    let raf = 0;
    const from = shownRef.current;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 600);
      const value = from + (r.total - from) * (1 - Math.pow(1 - p, 3));
      shownRef.current = value;
      setShown(value);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [r.total]);

  // --- avanzar ------------------------------------------------------------------
  const advancing = useRef(false);
  const next = useCallback(() => {
    if (advancing.current) return;
    advancing.current = true;
    setTimeout(() => {
      advancing.current = false;
    }, 350);
    const cur = stateRef.current;
    const all = buildSteps(quoter, cur.sector);
    const leaving = all[cur.step];
    if (cur.sector && leaving && !leaving.sector) {
      emit('presupuestador_paso', { sector: cur.sector, paso: leaving.id, indice: cur.step });
      if (leaving.id === 'widgets') {
        const piezas = cur.answers.widgets;
        emit('presupuestador_piezas', { sector: cur.sector, piezas: Array.isArray(piezas) ? piezas.join(',') : '' });
      }
    }
    if (cur.step < all.length - 1) commit({ ...cur, step: cur.step + 1 });
    else commit({ ...cur, showResult: true });
    // Con la posición en la página, no offsetTop: insertado en otra web, el
    // padre de referencia puede ser cualquier cosa. Y por debajo de la cabecera
    // fija de esa web, si la tiene.
    const wrap = wrapRef.current;
    if (wrap) {
      const offset = parseFloat(getComputedStyle(wrap).getPropertyValue('--quoter-sticky-top')) || 20;
      window.scrollTo({ top: wrap.getBoundingClientRect().top + window.scrollY - offset, behavior: 'smooth' });
    }
  }, [quoter, commit, emit]);

  function choose(stepId: string, type: 'single' | 'multi', isSector: boolean | undefined, id: string) {
    const cur = stateRef.current;
    if (type === 'multi') {
      const arr = new Set(Array.isArray(cur.answers[stepId]) ? (cur.answers[stepId] as string[]) : []);
      if (arr.has(id)) arr.delete(id);
      else arr.add(id);
      commit({ ...cur, answers: { ...cur.answers, [stepId]: [...arr] } });
      return;
    }
    let base = cur;
    if (isSector && cur.sector !== id) {
      base = { ...cur, sector: id, answers: {} };
      try {
        window.history.replaceState(null, '', `#${id}`);
      } catch {
        // Un marco con sandbox puede prohibirlo; el enlace directo es un extra.
      }
      emit('presupuestador_sector', { sector: id });
    }
    commit({ ...base, answers: { ...base.answers, [stepId]: id } });
    setTimeout(next, 280);
  }

  // --- pantalla -----------------------------------------------------------------
  const s = steps[state.step] ?? steps[0];
  const total = state.sector ? steps.length : baseSteps.length + 1;
  const pct = Math.round((state.step / total) * 100);
  const sel = state.answers[s.id];
  const isLast = state.step === steps.length - 1 && Boolean(state.sector);
  const multiCount = Array.isArray(sel) ? sel.length : 0;
  const canNext = s.optional || s.type === 'multi' || Boolean(sel);
  const L = config.launch;
  const totalText = r.total ? fmt(quoter, shown) : '—';

  return (
    <div className={styles.root}>
      {preview ? <div className={styles.previewBanner}>Vista previa de operador: esta página todavía no está publicada.</div> : null}

      {embedded ? null : (
        <header className={styles.top}>
          <div className={styles.brand}>
            <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <circle cx="16" cy="16" r="11" />
              <path d="M16 5v22M5 16h22" opacity=".35" />
              <circle cx="16" cy="16" r="4" />
            </svg>
            <div>
              Kairikos<small>Web Premium · multisector</small>
            </div>
          </div>
          <span className={styles.pill}>⏱ 2 minutos · Sin compromiso</span>
        </header>
      )}

      <section className={cx('hero', fading && 'fade')}>
        <div className={styles.eyebrow}>Presupuestador instantáneo</div>
        <h1 className={styles.serif}>
          <Rich text={hero.h1} />
        </h1>
        <p>{hero.p}</p>
      </section>

      <main className={styles.wrap} ref={wrapRef}>
        <section className={cx('card', 'stepper')} aria-live="polite" data-testid="quoter-stepper">
          {state.showResult && sec ? (
            <Result quoter={quoter} sectorId={state.sector as string} answers={state.answers} emit={emit} submitUrl={submitUrl} onEdit={() => commit({ ...stateRef.current, step: 1, showResult: false })} />
          ) : (
            <>
              <div className={styles.progress}>
                <div className={styles.bar}>
                  <i style={{ width: `${pct}%` }} />
                </div>
                <span className={styles.lbl}>
                  Paso {state.step + 1} de {total}
                </span>
              </div>
              <div className={styles.anim} key={s.id}>
                <div className={styles['step-head']}>
                  <div className={styles.kicker}>{s.kicker}</div>
                  <h2 className={styles.serif}>{s.title}</h2>
                  <p>{s.sub}</p>
                </div>
                <div className={cx('opts', s.sector && 'sectors')} role={s.type === 'multi' ? 'group' : 'radiogroup'} aria-label={s.title}>
                  {s.options.map((o) => {
                    const on = s.type === 'multi' ? Array.isArray(sel) && sel.includes(o.id) : sel === o.id;
                    const free = !o.note && !o.price && !o.monthly && !(o.mult && o.mult !== 1);
                    return (
                      <button
                        key={o.id}
                        type="button"
                        className={cx('opt', s.type === 'multi' && 'multi', s.sector && 'sector')}
                        role={s.type === 'multi' ? 'checkbox' : 'radio'}
                        aria-checked={on}
                        data-testid={`quoter-opt-${o.id}`}
                        onClick={() => choose(s.id, s.type, s.sector, o.id)}
                      >
                        {o.tag ? <span className={styles.tag}>{o.tag}</span> : null}
                        <span className={styles.chk}>
                          <Check />
                        </span>
                        <span className={styles.ic}>
                          <Icon name={o.icon} />
                        </span>
                        <span className={styles.t}>{o.label}</span>
                        <span className={styles.d}>{o.desc}</span>
                        <span className={cx('p', free && 'free')}>{priceText(quoter, state.answers, o)}</span>
                      </button>
                    );
                  })}
                </div>
                <div className={styles.nav}>
                  {state.step > 0 ? (
                    <button type="button" className={cx('btn', 'ghost')} onClick={() => commit({ ...stateRef.current, step: stateRef.current.step - 1 })}>
                      ← Atrás
                    </button>
                  ) : (
                    <span className={styles.hint}>Puedes cambiar cualquier respuesta después.</span>
                  )}
                  <button type="button" className={cx('btn', 'primary')} disabled={!canNext} onClick={next} data-testid="quoter-next">
                    {isLast ? 'Ver mi presupuesto' : s.type === 'multi' && !multiCount ? 'Saltar' : 'Continuar'} →
                  </button>
                </div>
              </div>
            </>
          )}
        </section>

        <aside className={styles['summary-col']}>
          <div className={cx('card', 'summary')} data-testid="quoter-summary">
            {sec ? (
              <div className={styles.chip}>
                <Icon name={sec.icon} />
                {sec.name}
              </div>
            ) : null}
            {L.enabled ? (
              <div className={styles.launch}>{L.label}</div>
            ) : null}
            <div className={styles.lbl}>Inversión estimada</div>
            <div className={cx('total', 'serif')}>
              {r.total ? (
                <>
                  {totalText.replace(` ${config.currency}`, '')}
                  <small> {config.currency}</small>
                </>
              ) : (
                '—'
              )}
            </div>
            {r.total && r.perMonth ? (
              <div className={styles.cuotas}>
                o {config.installments} cuotas de <b>{fmt(quoter, r.perMonth)}/mes</b> sin recargo
              </div>
            ) : null}
            <div className={styles.range}>
              {r.total ? `Horquilla orientativa: ${fmt(quoter, r.low)} – ${fmt(quoter, r.high)}` : sec ? 'Elige el tipo de proyecto' : 'Empieza eligiendo tu sector'}
            </div>
            {r.monthly ? (
              <div className={styles.monthly}>
                <span>Servicios Kairikos</span>
                <b>{fmt(quoter, r.monthly)}/mes</b>
              </div>
            ) : null}
            <ul>
              {r.lines.length ? (
                r.lines.map((l, i) => (
                  <li key={`${l[0]}-${i}`}>
                    <span>{l[0]}</span>
                    <span>{l[1]}</span>
                  </li>
                ))
              ) : (
                <li className={styles.empty}>Aquí verás el desglose de cada pieza.</li>
              )}
            </ul>
            <div className={styles.incl}>
              <b>Siempre incluido:</b> {config.included.join(' · ')}
            </div>
            <div className={styles.meta}>
              <div>
                <span>Plazo</span>
                <b>{r.total ? `${r.weeks} sem.` : '—'}</b>
              </div>
              <div>
                <span>Piezas</span>
                <b>{r.lines.length}</b>
              </div>
            </div>
            {config.socialProof ? (
              <div className={styles.trust}>
                <Icon name="star" />
                <span>{config.socialProof}</span>
              </div>
            ) : null}
            <p className={styles.note}>{config.ivaNote}</p>
          </div>
        </aside>
      </main>

      <div className={styles.mbar}>
        <div>
          <span>Inversión estimada</span>
          <b>{totalText}</b>
        </div>
        <div className={styles.m}>{r.monthly ? `+ ${fmt(quoter, r.monthly)}/mes` : r.total ? `${r.weeks} semanas` : ''}</div>
      </div>
    </div>
  );
}

function Result({
  quoter,
  sectorId,
  answers,
  emit,
  submitUrl,
  onEdit,
}: {
  quoter: QuoterData;
  sectorId: string;
  answers: QuoterAnswers;
  emit: QuoterEventSink;
  submitUrl: string;
  onEdit: () => void;
}) {
  const { config } = quoter;
  const sec = quoter.sectors[sectorId];
  const selection = { sector: sectorId, answers };
  const r = compute(quoter, selection);
  const L = config.launch;
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    if (!f.checkValidity()) {
      f.reportValidity();
      return;
    }
    setSending(true);
    setError(null);
    const fields = Object.fromEntries(new FormData(f)) as Record<string, string>;
    try {
      const res = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...fields, consent: fields.consent === 'on', sector: sectorId, respuestas: answers }),
      });
      if (!res.ok) {
        setError(res.status === 429 ? 'Has hecho demasiadas solicitudes hoy. Escríbenos a contacto@kairikos.com y lo vemos.' : 'No hemos podido enviarlo. Inténtalo de nuevo en un momento.');
        return;
      }
      emit('presupuestador_envio', { sector: sectorId });
      setSent(true);
    } catch {
      setError('No hemos podido enviarlo. Comprueba tu conexión e inténtalo de nuevo.');
    } finally {
      setSending(false);
    }
  }

  const [before, after] = QUOTER_CONSENT.text.split(QUOTER_CONSENT.linkText);

  return (
    <>
      <div className={styles.progress}>
        <div className={styles.bar}>
          <i style={{ width: '100%' }} />
        </div>
        <span className={styles.lbl}>Tu presupuesto</span>
      </div>
      <div className={cx('anim', 'result')}>
        <div className={styles.chip}>
          <Icon name={sec.icon} />
          {sec.name}
        </div>
        <div className={styles.eyebrow}>Estimación preliminar</div>
        <h2 className={styles.serif}>Tu web premium, a medida de tu negocio.</h2>
        <div className={styles.big} data-testid="quoter-result">
          <div className={cx('box', 'dark')}>
            <span>{L.enabled ? L.label : 'Inversión única'}</span>
            <b>
              {fmt(quoter, r.low)} – {fmt(quoter, r.high)}
            </b>
          </div>
          {r.perMonth ? (
            <div className={styles.box}>
              <span>O en {config.installments} cuotas sin recargo</span>
              <b>{fmt(quoter, r.perMonth)}/mes</b>
            </div>
          ) : null}
          {r.monthly ? (
            <div className={styles.box}>
              <span>Servicios Kairikos</span>
              <b>{fmt(quoter, r.monthly)}</b>
            </div>
          ) : null}
          <div className={styles.box}>
            <span>Plazo estimado</span>
            <b>{r.weeks} semanas</b>
          </div>
        </div>
        {L.enabled ? <div className={cx('launch', 'big-l')}>{L.label}. A cambio, te pedimos poder publicar tu caso y tus resultados a los 3 meses.</div> : null}
        <div className={styles.inclbox}>
          <b>Siempre incluido</b>
          <ul>
            {config.included.map((x) => (
              <li key={x}>
                <Check />
                {x}
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.insight}>
          <Rich text={insightFor(quoter, selection)} />
        </div>
        {sent ? null : (
          <>
            <h3 className={styles.serif} style={{ fontSize: 22, marginBottom: 4 }}>
              Recibe la propuesta detallada
            </h3>
            <p className={styles.hint} style={{ marginBottom: 14 }}>
              Te enviamos el desglose y reservamos una llamada de 20 minutos para afinarlo.
            </p>
            <form className={styles.lead} onSubmit={submit} noValidate data-testid="quoter-form">
              <label>
                Nombre *<input name="nombre" required minLength={2} autoComplete="name" />
              </label>
              <label>
                Empresa *<input name="empresa" required minLength={2} autoComplete="organization" />
              </label>
              <label>
                Email *<input name="email" type="email" required autoComplete="email" />
              </label>
              <label>
                Teléfono
                <input name="tel" type="tel" autoComplete="tel" />
              </label>
              <label className={styles.full}>
                Web actual (opcional)
                <input name="web" placeholder="https://" />
              </label>
              <label className={styles.full}>
                ¿Cuándo prefieres la llamada?
                <select name="franja">
                  {QUOTER_CALL_SLOTS.map((slot) => (
                    <option key={slot}>{slot}</option>
                  ))}
                </select>
              </label>
              <div className={styles.trap} aria-hidden="true">
                <label>
                  No rellenes este campo
                  <input name="website" tabIndex={-1} autoComplete="off" />
                </label>
              </div>
              <label className={cx('consent', 'full')}>
                <input type="checkbox" name="consent" required />
                <span>
                  {before}
                  <a href={QUOTER_CONSENT.privacyUrl} target="_blank" rel="noreferrer">
                    {QUOTER_CONSENT.linkText}
                  </a>
                  {after}
                </span>
              </label>
              {error ? (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}
              <div className={styles.full} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
                <button className={cx('btn', 'gold')} type="submit" disabled={sending} data-testid="quoter-submit">
                  Enviarme la propuesta →
                </button>
                <button className={cx('btn', 'ghost')} type="button" onClick={onEdit}>
                  Modificar respuestas
                </button>
              </div>
            </form>
          </>
        )}
        {sent ? (
          <div className={styles.ok} style={{ display: 'block' }} data-testid="quoter-thanks">
            <div className={styles.seal}>
              <Check size={26} />
            </div>
            <h3 className={styles.serif} style={{ fontSize: 26 }}>
              ¡Gracias! Propuesta en camino.
            </h3>
            <p className={styles.hint} style={{ marginTop: 8 }}>
              {config.thanksText}
            </p>
          </div>
        ) : null}
      </div>
    </>
  );
}
