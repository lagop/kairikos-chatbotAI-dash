# Costes variables y dónde está cada tope

Escrito el 24/09/2026. Todo lo que en este sistema cuesta dinero por uso —Google
Places, la API de Anthropic, Twilio— y qué le impide dispararse.

La regla de la que sale todo lo de abajo: **una factura variable es justo la
ansiedad contra la que se vende este catálogo**. Si nosotros no podemos predecir
lo que nos va a costar un cliente, no podemos venderle una tarifa plana sin
riesgo de vender por debajo de coste.

## Los topes, todos juntos

| Dónde | Tope | Constante | Por qué |
|---|---|---|---|
| Barrido de borradores de web | 20 al día, entre todos los clientes | `DAILY_DRAFT_CAP` (`web-draft-sweep.ts`) | Cada borrador son unos 2 céntimos de Sonnet |
| Formulario público de borradores | 50 al día en total | `MAX_DRAFTS_PER_DAY_GLOBAL` (`public-draft-request.ts`) | El único tope que acota el gasto pase lo que pase |
| Formulario público de borradores | 3 por IP y día | `MAX_DRAFTS_PER_IP_PER_DAY` | El goteo de un curioso |
| Formulario de las webs publicadas | 20 envíos por hora y sitio | `MAX_SUBMISSIONS_PER_HOUR` (`website-form.ts`) | Un bot llenando la bandeja del cliente |
| Informe comparativo | Bajo demanda + caché de 30 días | `SNAPSHOT_TTL_DAYS` (`prospecting-competitors.ts`) | Cada informe son varias búsquedas de pago en Google |
| Informe comparativo | 3 competidores por informe | `MAX_COMPETITORS` | Cada competidor es una consulta más |
| Prospección, leads por campaña | 100 / 300 / 800 según tarifa | `TIER_LEAD_CAP` (`prospecting.ts`) | Es lo que ata el coste de Places a la tarifa cobrada |
| Calculadora pública | **sin tope, a propósito** | — | Solo multiplica: no llama a ningún modelo ni a Google |

Si añades algo que llame a un modelo o a una API de pago, **el tope es parte de
la tarea**, y su sitio es esta tabla.

## Google Places

Los SKU que usa el portal, de más barato a más caro:

| SKU | Cuándo se pide | Gratis al mes |
|---|---|---|
| Text Search (Essentials) | Búsqueda del barrido, sin valoraciones | 10.000 |
| Text Search (Pro) | Cuando se piden valoraciones y nº de reseñas | 5.000 |
| Place Details (Enterprise) | Ficha concreta por id | 1.000 |
| Place Details (Enterprise + Atmosphere) | Ficha con reseñas | 1.000 |

`google-places.ts` separa las máscaras de campos a propósito
(`SEARCH_FIELD_MASK` frente a `SEARCH_WITH_RATINGS_FIELD_MASK`, detrás de
`includeRatings`): pedir la valoración sube el SKU de Essentials a Pro, y la
mitad de las búsquedas no la necesitan.

### Lo que falta, y es de panel, no de código

**No hay cuota diaria ni presupuesto con alerta puestos en Google Cloud.** Es el
único gasto del sistema sin techo puesto por nosotros: los topes de la tabla de
arriba acotan cuántas veces llamamos, pero nada impide que una llamada mal
escrita en un bucle nuevo se salte esa contabilidad. Se configura en la consola
de Google Cloud, no aquí:

1. **Cuotas por día** en la API de Places, por SKU. Ponlas cerca del volumen real
   más un margen, no en el máximo: una cuota que nunca salta no protege de nada.
2. **Presupuesto con alerta** en Facturación, con avisos al 50 %, 90 % y 100 %.
   El presupuesto **no corta el gasto**, solo avisa — el corte de verdad son las
   cuotas.

## Anthropic

Modelo por defecto de cada integración, y el porqué cuando no es el barato:

- `web-draft-ai.ts` usa **`claude-sonnet-5`** (`DEFAULT_MODEL`). Es lo que se le
  enseña a un desconocido en la primera llamada; Haiku escribe textos que se
  notan de plantilla.
- El resto de integraciones usan `claude-haiku-4-5-20251001` por defecto,
  sobreescribible desde `/admin/portal/settings/anthropic`.

Precios por millón de tokens (entrada/salida), comprobados el 24/09/2026:
Haiku 4.5 1 $/5 $ · Sonnet 5 2 $/10 $ · Opus 5 5 $/25 $.

El override por variable de entorno (`ANTHROPIC_*_MODEL`) **no está en
`docker-compose.yml`**: en la VPS no llega al contenedor. El modelo se cambia en
la pantalla de ajustes, no en el `.env`.

## Twilio (recall)

El coste es lineal por línea: número, minutos y transcripción. Por eso `recall`
se vende **un contrato por línea** y no con un tope por tarifa — ver la sección
"Cuando un cliente quiere dos de algo" en `CLAUDE.md`.

La transcripción corre hoy en **Groq**, no en el Whisper autoalojado que describe
el diseño. Eso es una dependencia de terceros con datos de voz de clientes y
tiene su propio pendiente legal (declarar a Groq como subencargado, art. 28
RGPD), que no es de coste sino de contrato.

## Lo que NO cuesta por uso

El alojamiento propio de webs de cliente (`publishTarget: 'kairikos'`) son dos
filas en Postgres y un `GET` servido por el portal. Es casi gratis para nosotros,
y por eso existe: para el cliente que no tiene alojamiento y al que, si no, no se
le puede vender una web de ninguna manera.
