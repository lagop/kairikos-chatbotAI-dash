import { createRoot } from 'react-dom/client';
import { PremiumQuoter, type QuoterEventSink } from '@/components/public/PremiumQuoter';
import type { QuoterData } from '@/lib/premium-quoter-engine';

// =============================================================================
// El presupuestador de Web Premium, para insertarlo en otra web (10/11/2026).
//
// Lo empaqueta scripts/build-embed.mjs en public/embed/presupuestador.js, con
// React y el CSS dentro. kairikos.com lo carga así:
//
//   <div id="kairikos-presupuestador">…texto para quien no tenga JavaScript…</div>
//   <script src="https://portal.kairikos.cloud/embed/presupuestador.js" defer></script>
//
// Sustituye a un marco (iframe) que tenía su propio scroll dentro del de la
// página. Aquí el componente se pinta en la página misma, así que el resumen
// pegado a un lado y la barra fija del móvil se colocan respecto a la pantalla.
//
// - SHADOW DOM. El CSS del tema de WordPress no entra y el del presupuestador
//   no sale. Lo único que cruza a propósito son las variables --quoter-*, que
//   pone la página para decirle dónde está su cabecera fija y sus botones
//   flotantes, y qué letra usa.
//
// - LOS DATOS LLEGAN AL CARGAR, de GET /api/public/presupuestador: textos y
//   precios del momento, del mismo catálogo que /planes/. Si no está publicado
//   o no responde, no se pinta nada y se queda el texto de dentro del div.
//
// - LA ANALÍTICA va a window.kairikosEvento, la función de la web que decide
//   si se manda a GA4 según las cookies que aceptó el visitante.
// =============================================================================

declare const __QUOTER_CSS__: string;

declare global {
  interface Window {
    kairikosEvento?: (nombre: string, datos?: Record<string, unknown>) => void;
  }
}

const HOST_ID = 'kairikos-presupuestador';

// Se lee al ejecutarse el script, que es cuando currentScript existe.
const scriptSrc = (document.currentScript as HTMLScriptElement | null)?.src;
const endpoint = `${new URL(scriptSrc || 'https://portal.kairikos.cloud/').origin}/api/public/presupuestador`;

const onEvent: QuoterEventSink = (evento, datos) => {
  if (typeof window.kairikosEvento === 'function') window.kairikosEvento(evento, datos);
};

async function mount() {
  const host = document.getElementById(HOST_ID);
  if (!host || host.shadowRoot) return;

  let quoter: QuoterData;
  try {
    const res = await fetch(endpoint, { credentials: 'omit' });
    if (!res.ok) return;
    quoter = ((await res.json()) as { quoter: QuoterData }).quoter;
  } catch {
    return;
  }

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  // all:initial corta lo que heredaría del tema (tamaño de letra, interlineado,
  // color). Las variables CSS no las toca: así siguen llegando las --quoter-*.
  style.textContent = `:host{all:initial;display:block}\n${__QUOTER_CSS__}`;
  const container = document.createElement('div');
  shadow.append(style, container);
  createRoot(container).render(<PremiumQuoter quoter={quoter} embedded preview={false} submitUrl={endpoint} onEvent={onEvent} />);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void mount());
else void mount();
