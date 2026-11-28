# Informe mensual de resultados de la web Premium

28/11/2026. Una vez al mes, el cliente de una web Premium con Cuidado recibe por email lo que su web produjo el mes anterior, comparado con el mes de antes. Lo mismo se ve en su panel, en la página de su web. Es lo que justifica la cuota del Cuidado Premium (129 €/mes): un cliente que no ve qué le da su web se pregunta para qué paga.

Código:

| Pieza | Archivo |
| --- | --- |
| Reglas del contrato (tipos, orígenes, token, origen) | `portal/src/lib/web-events-rules.ts` |
| Ruta pública de eventos | `portal/src/app/api/public/web-events/[token]/route.ts` |
| Escritura, token y estado para el operador | `portal/src/lib/web-events.ts` |
| Cifras, correo y barrido mensual | `portal/src/lib/web-results-report.ts` |
| Panel del cliente | `portal/src/components/portal/WebResultsCard.tsx` en `/portal/web/[clientProductId]` |
| Activación (operador) | `portal/src/components/admin/WebResultsTrackingPanel.tsx` y `POST /api/admin/portal/web/[clientProductId]/results-tracking` |
| Tablas | `client_site.events_token`, `client_site.last_results_report_at`, `web_event_day` (migración `20261128120000_resultados_web`) |

## Qué mide

| Cifra | De dónde sale |
| --- | --- |
| Visitas | Eventos `landing` de la web, todos los orígenes |
| Visitas desde buscadores con IA | `landing` con origen `ai` (ChatGPT, Perplexity, Claude, Gemini, Copilot) |
| Llamadas desde la web | `call_click`: toques en el enlace `tel:`. Es una intención de llamar, no una llamada confirmada |
| WhatsApp | `whatsapp_click` |
| Emails | `email_click` |
| Formularios y reservas | `form_submit` + `booking_submit`, guardados por separado |
| Conversaciones en el chat | Las `ChatbotConversation` del chatbot del portal de ese sitio. Si el sitio no tiene chatbot del portal, los `chat_start` de la web |
| Llamadas perdidas recuperadas | `CallEvent` de la línea de Modo Recado de ese sitio, sin las `blocked` |

**Contactos** (lo que encabeza el correo) = llamadas desde la web + WhatsApp + emails + formularios y reservas.

El correo no convierte nada en euros ni en citas: cuenta toques y envíos, y lo dice.

## Contrato de eventos (para las webs Astro)

```
POST https://portal.kairikos.cloud/api/public/web-events/<token>
Content-Type: text/plain          (lo que pone sendBeacon con una cadena; sin preflight)
             o application/json
Cuerpo: {"k": "<tipo>", "s": "<origen>"}     máximo 512 bytes
Respuesta: 204 siempre, sin cuerpo, con Access-Control-Allow-Origin: *
```

- **Token**: `wev_` + 32 caracteres `[A-Za-z0-9_-]`. Es público: va en el HTML. En la web, en `PUBLIC_EVENTS_ENDPOINT` (la URL completa). Sin la variable, la web no manda nada.
- **Tipos** (`k`): `landing`, `call_click`, `whatsapp_click`, `email_click`, `form_submit`, `booking_submit`, `chat_start`. Cualquier otro se ignora.
- **Origen** (`s`): solo en `landing`; en los demás tipos se guarda vacío aunque se mande. Valores: `ai`, `search`, `social`, `other`, `direct`. Un `landing` sin origen o con uno desconocido cuenta como `other`.
- **204 siempre**, cuente o no: token desconocido, tipo inválido, cuerpo grande, origen que no es la web, bot o límite superado. La web no lee la respuesta.
- **Cuándo no cuenta**:
  - si el sitio tiene `siteUrl` y la cabecera `Origin` (o, si falta, `Referer`) no es ese host o un subdominio suyo (con o sin `www`);
  - si el user agent contiene `bot`, `crawler`, `spider` o `headless`;
  - a partir de 60 eventos por minuto de la misma IP con el mismo token;
  - si el sitio está archivado.

Cómo decide la web el origen de un `landing` (con `document.referrer`, al cargar la página; sin guardar nada en `sessionStorage` ni cookies):

| Origen | Referrer que contiene |
| --- | --- |
| `ai` | `chatgpt.com`, `chat.openai.com`, `perplexity.ai`, `claude.ai`, `gemini.google.com`, `copilot.microsoft.com` (o `utm_source=chatgpt.com` en la URL) |
| `search` | `google.`, `bing.com`, `duckduckgo.com`, `yahoo.`, `ecosia.org` |
| `social` | `facebook.com`, `instagram.com`, `t.co`, `x.com`, `linkedin.com`, `tiktok.com` |
| `direct` | referrer vacío |
| `other` | cualquier otro host externo |

Un referrer del propio sitio no es una llegada: no se manda `landing`. Así, pasar de una página a otra de la web no cuenta otra visita, sin necesidad de recordar nada en el navegador. Una recarga de la página de entrada vuelve a contar (el navegador conserva el referrer): es una aproximación aceptada.

Ejemplo mínimo:

```js
const endpoint = import.meta.env.PUBLIC_EVENTS_ENDPOINT;
function track(k, s) {
  if (!endpoint) return;
  const body = JSON.stringify(s ? { k, s } : { k });
  if (!navigator.sendBeacon?.(endpoint, body)) {
    fetch(endpoint, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(() => {});
  }
}
```

## Privacidad

- Solo contadores agregados por día: (sitio, día, tipo, origen, total). Una fila por combinación; cada evento suma 1.
- Ni cookies, ni identificadores, ni nada guardado en el dispositivo del visitante.
- Ni IP ni user agent en la base de datos. La IP se usa solo en memoria, un minuto, para el límite de abuso.
- `REVISAR ABOGADO`: base jurídica de la medición agregada sin cookies (marcado también en la ruta). Mientras no se confirme, la web lo menciona en su política de cookies o privacidad como medición sin cookies.

## Cómo activarlo para un cliente

1. La web (`web`) del cliente tiene que estar activa. Su sitio (`client_site`) debería tener `site_url`: sin ella no se comprueba el origen y cuenta eventos de cualquier web.
2. En `/admin/portal/<clientId>?product=web`, en el bloque de la web, **Medición de resultados → Activar medición de resultados**. Devuelve y enseña la URL de eventos. Es idempotente: si ya hay token, enseña el mismo. No hay botón para rotarlo, porque la web publicada dejaría de contar.
3. Copiar la URL a `PUBLIC_EVENTS_ENDPOINT` en la configuración de la web Astro y republicarla.
4. Comprobar en la misma ficha que aparece «Último evento recibido».
5. El correo mensual sale si el sitio tiene un Cuidado (`web_care`) activo. Hoy vale cualquier nivel: el nivel Premium solo se deduce de `customPriceCents` (12900/17900) y no es una columna. Si hace falta limitarlo a Premium, el filtro va en `sendWebResultsReports`.

## Cuándo sale el informe

- Lo dispara `/api/cron/client-health-tick`, que ya está en `scripts/scheduler.sh` (cada 5 minutos).
- Toca el día 1 desde las 09:00 de Canarias. Si el scheduler estuvo caído, el 2 y el 3 aún lo mandan; después, ese mes se salta.
- Una vez por mes y sitio: el cursor `client_site.last_results_report_at` se compara por mes y avanza tras cada intento, salga o no el correo (como el informe de valor semanal). Un mes sin ninguna actividad no manda nada, pero avanza el cursor.
- Destinatario: `ChatbotClient.email`. Remitente: `notifyFromAddress()`. Necesita `RESEND_API_KEY`, que ya existe.
- El día local es el de Canarias (`Atlantic/Canary`), tanto para los contadores como para el mes del informe.

## Puesta en marcha

1. Aplicar la migración `20261128120000_resultados_web` en la VPS con `scripts/vps-migrate-deploy.sh` (trampa 3 de `CLAUDE.md`).
2. Desplegar. No hay variables de entorno nuevas en el portal.
3. Activar la medición por cliente (arriba) y poner `PUBLIC_EVENTS_ENDPOINT` en cada web.
4. El día 1 siguiente, mirar la respuesta de `client-health-tick` (`webResults`) y los logs `web_results_report.*`. Una suite verde no dice si el correo sale (trampa 4).
