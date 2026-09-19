# Fase 1 — el eje multi-instancia

> **Estado: fase 1 implementada** (18 de septiembre de 2026). Los apartados
> marcados *"Corregido al implementar"* recogen dónde la realidad no coincidió
> con el plan.
>
> Se hizo antes de vender en producción, y ese "antes" era la premisa entera:
> sin datos de clientes que migrar se puede cambiar la columna por la que se
> identifica media base de datos. Con un solo cliente vivo, habría habido que
> plantearlo de otra forma.

## El problema

Un cliente no puede contratar dos veces el mismo producto. SEO para dos webs,
un chatbot por cada negocio, Reseñas para dos fichas: nada de eso se puede
vender hoy. El bloqueo está en **tres** capas, coherentemente:

- `createProductCheckoutSession` devuelve `409 already_contracted` cuando el
  producto ya está activo (`stripe-billing.ts`).
- El alta manual de operador reutiliza la fila existente en vez de crear otra
  (`client-product-activation.ts`), con una única excepción explícita:
  `product.code === 'web' ? null : findFirst(...)`.
- Y la capa que no se ve desde el código de aplicación, encontrada al
  implementar: **un índice único PARCIAL en Postgres**,
  `ClientProduct_client_id_product_id_non_web_key`, creado por
  `20260901120000_client_product_web_multiplicity`. Es la garantía de verdad;
  las dos de arriba son cortesías. Levantar la guarda de un producto exige
  tocar también este índice, cuyo predicado excluye hoy solo a `web`.

  Ese índice es además el **precedente exacto** de este plan: su migración se
  titula "Phase 1 of multiple web projects per client". Esto ya se hizo una vez,
  para un producto. Aquí se generaliza.

  Un detalle con filo: el índice es sobre `(client_id, product_id)`, y
  `product_id` identifica código **y tarifa**. A nivel de base de datos, dos
  tarifas distintas del mismo código (Reseñas Basic y Pro) ya se podrían
  coexistir; lo que lo impide es `already_contracted`, que compara por código.

`web` es, por eso, el único producto multi-instancia del portal, y su ruta
`/portal/web/[clientProductId]` es el patrón de referencia de todo este plan.

## Lo que esta fase hace, y lo que deliberadamente no hace

**Hace**: construye el eje sobre el que los productos se convierten después —
la entidad de sitio, la forma nueva de autorizar, la convención de rutas y las
tres columnas que hacen que las rutas internas sepan de qué instancia hablan.

**No hace**: convertir ningún producto, y **no levanta `already_contracted`**.
Al terminar la fase 1 el comportamiento observable es idéntico al de hoy: cada
cliente sigue teniendo como mucho una instancia de cada producto, y todo el
código nuevo devuelve exactamente lo que devolvía el viejo. Levantar la guarda
antes de que un producto sepa manejar dos instancias crearía filas que ese
producto resolvería al azar — ver "El fallo latente" más abajo.

Esa es la propiedad que hace segura una fase de tres semanas: **no hay ningún
punto intermedio en el que el portal se comporte distinto**.

## La decisión de diseño: un sitio, no una maraña de asociaciones

El encargo incluía que "los productos que pueden asociarse a otros ya
contratados puedan asociarse correctamente": que el SEO de la web A y el
chatbot de la web A se reconozcan entre ellos.

Hay dos formas de construir eso. Asociar productos por pares (este SEO con este
chatbot, estas Reseñas con este SEO) hace crecer las relaciones con el cuadrado
del número de productos, y obliga a decidir, cada vez que nace un producto,
cómo se ata a los otros seis. Es la forma que se rompe.

La que no se rompe: **una entidad de sitio/negocio, y cada contratación apunta
a uno**. Entonces "asociarse correctamente" deja de ser una relación que
mantener — es una consecuencia: dos productos que miran al mismo sitio se ven
entre sí, sin que nadie declare nada.

```
Negocio A (clinicacentro.es)   →  chatbot · seo · reseñas
Negocio B (fisiosur.es)        →  chatbot · seo
```

Y aparece gratis lo que el cliente quiere ver —el panel agrupado por negocio, no
una lista plana de contratos— y la respuesta a "¿a cuál de mis dos negocios
pertenece este lead?".

## Modelo de datos

### `ClientSite` (nuevo)

```prisma
model ClientSite {
  id       String  @id @default(uuid()) @db.Uuid
  clientId String  @map("client_id")
  tenantId String? @map("tenant_id") @db.Uuid

  // Como lo llama el cliente, no como lo llamamos nosotros: "Clínica
  // Centro", no "instancia 2". Es lo que se pinta en el selector.
  name    String
  siteUrl String? @map("site_url")

  // El sitio al que van a parar las contrataciones que no declaran uno.
  // Exactamente uno por cliente — ver el índice parcial en la migración:
  // Prisma no sabe expresar "único donde is_primary", así que lo impone
  // el DDL a mano y esto queda documentado aquí.
  isPrimary Boolean @default(false) @map("is_primary")

  archivedAt DateTime? @map("archived_at")
  createdAt  DateTime  @default(now()) @map("created_at")
  updatedAt  DateTime  @updatedAt @map("updated_at")

  client   ChatbotClient   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  products ClientProduct[]

  @@index([clientId])
  @@map("client_site")
}
```

`archivedAt` y no borrado: un sitio con histórico de métricas, conversaciones y
facturación no se borra nunca. Misma postura que el resto del esquema.

### `ClientProduct` gana un sitio

```prisma
  clientSiteId String?     @map("client_site_id") @db.Uuid
  clientSite   ClientSite? @relation(fields: [clientSiteId], references: [id])
```

**Nullable a propósito, y para siempre.** Una contratación sin sitio declarado
resuelve al sitio primario del cliente. Eso es lo que permite que la migración
no tenga que acertar en el backfill de cada fila, y que un alta de operador
siga funcionando sin elegir sitio.

### Las tres anclas

Este es el hallazgo que hace tratable la parte que parecía más arriesgada. Las
36 rutas de `/api/internal/*` resuelven el cliente desde un identificador
externo —nunca del cuerpo, esa es la regla del repo— y lo hacen a través de
**solo tres tablas**:

| Ancla | Desde qué | Rutas |
|---|---|---|
| `MetaChannelConnection` | `phone_number_id`, page id | 12 |
| `TelegramConnection` | bot id | 4 |
| `ChatbotConversation` | `conversationId` | 5 |

(`RecallSubscription` ya lleva `clientProductId @unique`; las seis rutas que
resuelven por `chatbotClient` son de ámbito de cliente y no cambian.)

Las tres reciben:

```prisma
  clientProductId String? @map("client_product_id") @db.Uuid
```

Con eso, **cada ruta interna obtiene la instancia del mismo `findFirst` que ya
hace**. No hay que revisar 36 rutas una a una; hay que añadir una columna a tres
tablas y un campo al `select` de cada ruta cuando su producto se convierta.

## La autorización cambia de forma, no de nombre

Hoy `isProductContracted(prisma, clientId, code) → boolean` se llama 33 veces, y
los dos helpers compuestos (`hasGoogleBusinessConnectAccess`,
`hasLeadsInboxAccess`) otras 35. Es la frontera de autorización del portal
entero.

Con multi-instancia la pregunta deja de ser *"¿este cliente tiene SEO?"* y pasa a
ser *"¿este cliente tiene SEO **para este sitio**?"*. Eso no es un parámetro
más: son **dos preguntas distintas, y las dos son legítimas**. La decisión de
este plan es no fusionarlas:

```ts
// ¿Enseño la pestaña, el mosaico, la entrada de menú?
// Ámbito de cliente. Se queda EXACTAMENTE como está, con 33 llamantes
// intactos. Nunca autoriza una escritura.
isProductContracted(prisma, clientId, code): Promise<boolean>

// ¿Puede este cliente operar sobre ESTA instancia?
// La frontera real. Toda ruta que escriba algo de un producto pasa por aquí.
resolveContractedInstance(prisma, {
  clientId,
  productCode,
  clientProductId,   // opcional — ver abajo
}): Promise<ContractedInstance | null>
```

```ts
export interface ContractedInstance {
  clientProductId: string;
  clientId: string;
  clientSiteId: string | null;
  code: string;
  tier: string;
  status: string;
}
```

**La regla, en una frase:** `isProductContracted` decide qué se ve;
`resolveContractedInstance` decide qué se puede tocar. Una ruta que escriba y
autorice con la primera es un fallo, y hay un test que lo vigila (ver
Verificación).

### Cómo no rompe nada mientras dura

`clientProductId` es opcional. Cuando no se pasa, `resolveContractedInstance`
devuelve la única instancia activa de ese producto — que es, hasta que se
levante `already_contracted`, literalmente lo que hace hoy el `findFirst` de
cada ruta. Con dos instancias y sin `clientProductId`, devuelve `null` en vez de
elegir: **negarse es el comportamiento correcto**, y es justo lo que hoy no
pasa.

La forma interna copia el patrón que `web` ya usa en
`/portal/web/[clientProductId]/page.tsx`: el id viene de la URL, pero la
consulta lo fija al `clientId` de la sesión **y** al código de producto, así que
un id de otro cliente no resuelve.

```ts
const row = await prisma.clientProduct.findFirst({
  where: {
    ...(clientProductId ? { id: clientProductId } : {}),
    clientId,
    status: 'active',
    product: { code: productCode },
  },
  select: {
    id: true,
    clientSiteId: true,
    status: true,
    product: { select: { code: true, tier: true } },
  },
  orderBy: { subscribedAt: 'asc' },
});
```

Ese `orderBy` no es cosmético — ver el apartado siguiente.

### El fallo latente que esto cierra de paso

Todas las lecturas de perfil de producto resuelven hoy con
`findFirst({ where: { clientId } })` **sin `orderBy`**: la página del cliente,
la auditoría del operador, las palabras clave, los dos callbacks de OAuth, la
conexión de WordPress. Con una sola instancia es correcto. Con dos, no falla:
coge una arbitraria, sin garantía de que sea la misma entre una llamada y la
siguiente. La auditoría podría correr sobre una web y el artículo publicarse en
la otra.

No es un límite defendido, es un descuido que hoy no se nota. La fase 1 lo cierra
aunque nunca se levantara la guarda.

## `listContractedProducts` se queda, pero por otra razón

> Corregido al implementar. El plan decía que esta función pasaría a devolver
> una fila por instancia. **No se hizo, y no debe hacerse.**

```ts
// Su comentario decía:
//   "deduped by product code (a client should not have two active rows
//    for the same code, but this defends against the data drift...)"
```

Esa premisa sí es la que el plan invalida: dos contrataciones del mismo código
son el caso normal, no una anomalía. Pero su **único** llamante es el selector
del asistente (`/portal/wizard`), que enruta por **código**
(`/portal/wizard/seo`) y no tiene concepto de instancia: devolver dos filas le
daría dos tarjetas apuntando a la misma URL. Eso es exactamente el punto
intermedio roto que esta fase existe para evitar.

Así que el dedup se queda y lo que cambia es el motivo, escrito en su
comentario. Para "qué contrataciones tiene, una por una, con su sitio" se añade
una función hermana, `listContractedInstances`, que no deduplica y que hoy
todavía no usa nadie.

## Migraciones

`prisma migrate dev` está roto en este repo (shadow DB: `function cuid() does
not exist`). SQL a mano, `db execute`, `migrate resolve --applied`, `generate`.
Cuatro migraciones, en este orden, cada una aplicable sola:

**1 · `client_site`** — la tabla, más el índice parcial que Prisma no sabe
declarar:

```sql
CREATE UNIQUE INDEX client_site_one_primary_per_client
  ON client_site (client_id) WHERE is_primary;
```

**2 · `client_product.client_site_id`** — columna nullable, FK, índice.

**3 · Las tres anclas** — `client_product_id` nullable + índice en
`MetaChannelConnection`, `TelegramConnection`, `ChatbotConversation`.

> Cuidado con los nombres de columna: los modelos nuevos usan `@map` a
> snake_case, **los antiguos no**. En `ChatbotConversation` la columna es
> literalmente `"clientId"`. Comprobar el modelo antes de escribir cada DDL.

**4 · Backfill** — un `ClientSite` primario por cliente existente, con
`siteUrl` tomado de `SeoProfile.siteUrl` si lo hay y el nombre del cliente si
no; todas sus `ClientProduct` apuntando a él; las tres anclas apuntando a la
instancia del producto que les corresponde. Idempotente y re-ejecutable: se
inserta solo lo que falta.

Los tests unitarios mockean Prisma, así que una suite verde no dice nada del
esquema: el backfill se verifica contra el Postgres real antes de dar la fase
por cerrada.

## Rutas

Convención, copiada de `web`:

```
/portal/<producto>                      índice
/portal/<producto>/[clientProductId]    una instancia
```

El índice con una sola instancia **redirige a ella**. Es lo que hace que, para
un cliente de un solo sitio, la interfaz sea idéntica a la de hoy: nadie ve un
selector con un elemento.

En la fase 1 solo se crea el helper de esa resolución y se documenta la
convención; las páginas se mueven cuando su producto se convierta.

## Qué no se toca

- **`leads` no será multi-instancia.** La bandeja está compartida a propósito
  entre Captación y Prospección (`hasLeadsInboxAccess`). Un cliente con dos
  negocios no quiere dos bandejas: quiere una con un filtro por sitio. Cuando
  `Lead` gane `clientSiteId` (fase 5), será para filtrar, no para separar.
- **La facturación.** `Subscription` ya va por `clientProductId`; dos instancias
  son dos suscripciones de Stripe sin cambiar nada.
- **Los productos.** Ninguno se convierte en esta fase.
- **`already_contracted`.** Se levanta producto a producto, en su fase.

## Verificación

1. `npx tsc --noEmit` limpio y `npx vitest run` entero en verde.
2. **Test de guarda estructural, en forma de trinquete** — el patrón que este
   repo ya usa para `KAIRIKOS_OPERATOR_EMAILS`: lee el código fuente, quita
   los comentarios y busca rutas de `/api/portal/*` que escriban
   (POST/PATCH/DELETE) y resuelvan la contratación por cliente.

   Dos correcciones sobre lo que decía este plan:

   - **No basta con vigilar `isProductContracted`.** `seo/profile/route.ts`
     no lo llama en absoluto: resuelve con un `prisma.clientProduct.findFirst`
     en línea. Un guardia que solo mirase el helper habría dado luz verde al
     caso más claro del problema. El patrón cubre las dos formas.
   - **No exige que las rutas estén convertidas**, porque la fase 1 no convierte
     ninguna. Congela la lista: 16 pendientes (agrupadas por la fase que les
     toca) y 2 que resuelven por cliente y está bien que lo hagan para siempre
     —`web-quote/request`, que crea la contratación y por tanto no tiene aún
     instancia, y `prospecting/campaign/suggest`, que es un POST que no
     escribe—. Falla si aparece una ruta nueva fuera de esas listas, y también
     si un pendiente desaparece de la lista sin convertirse.

   Con su "guarda de la guarda", verificada: se introdujo una ruta que viola la
   regla, el test falló nombrándola, y volvió a verde al retirarla.
3. **Contra el Postgres real**: el backfill deja exactamente un sitio primario
   por cliente, cero `ClientProduct` huérfanas, y las tres anclas resueltas.
4. **La prueba de que no cambió nada**: la suite entera antes y después del
   backfill da el mismo resultado. Si algo se comporta distinto en la fase 1, es
   un fallo, no un avance.

## Riesgos y límites aceptados

- **El backfill adivina el nombre del sitio.** Toma `SeoProfile.siteUrl` o el
  nombre del cliente. Con un puñado de clientes de prueba es irrelevante; se
  edita a mano si molesta.
- **Un producto sin sitio declarado resuelve al primario.** Es deliberado y
  permanente: mantiene el alta de operador simple. El precio es que un operador
  descuidado puede dejar una contratación en el sitio equivocado — visible y
  corregible, no silencioso.
- **La fase 1 no entrega valor observable.** Tres semanas sin que el cliente vea
  nada distinto. Es el coste de hacerlo sin un punto intermedio roto, y conviene
  decirlo en voz alta antes de empezar, no a mitad.
- **El orden de las cuatro migraciones importa** (la 4 depende de la 1-3), pero
  cada una es aplicable y reversible por separado.

## Después — replanteado el 18/09/2026, antes de seguir

> Este apartado sustituye al reparto original de fases. Se midió el código en
> vez de estimarlo, y dos de las cuatro fases que quedaban **no había que
> hacerlas**. Lo que sigue es lo decidido, con su razón.

### Lo que la medición encontró

**Producción está vacía**: 2 clientes, 3 contrataciones, y filas sueltas de las
pruebas propias. Cero conexiones de Google Business, cero conversaciones, cero
documentos de conocimiento. Toda conversión que quede puede usar el atajo
barato de la fase 2 —columna `NOT NULL` directa, sin ventana de backfill—.

**Reseñas ya estaba hecho.** `GoogleBusinessConnection` es
`@@unique([clientId, locationId])` y `src/lib/review-locations.ts` (de una
"Fase 3" anterior) ya resuelve varias fichas por cliente con tope por tarifa.
Su cabecera documenta incluso la misma trampa del `findFirst` sin orden que
apareció en SEO.

**El coste no está en el modelo de datos, está en la superficie.** En la fase 2
el esquema fue una hora; el resto fueron 11 rutas, 2 páginas, 7 componentes y 7
archivos de test. Medido así, Recall tiene **29 archivos de test** y el chatbot
**27** entre los suyos y los de canales y asistente — ahí está el trabajo.

### La regla de precio (decisión 1)

Cuando un cliente quiere dos de algo, **el modelo lo decide el coste marginal**,
no una preferencia global:

- **La segunda unidad no nos cuesta nada** → un contrato, tope por tarifa.
- **La segunda unidad cuesta dinero recurrente** → un contrato por unidad.

| Producto | Coste de la 2.ª unidad | Modelo |
|---|---|---|
| Reseñas | ~0, misma sincronización | tope por tarifa (1/3/10) |
| Prospección | 0 — `TIER_LEAD_CAP` ya ata el gasto | tope por tarifa |
| SEO | rastreo + Search Console + GA4 + generación con IA | contrato por unidad |
| Recall | número de Twilio, minutos, transcripción | contrato por unidad |
| Chatbot | conversaciones con IA + alta de operador | contrato por unidad |

Esto resolvió una contradicción que el repositorio ya tenía: Reseñas se
construyó con tope por tarifa —"una factura variable es justo la ansiedad
contra la que se vende este catálogo"— y SEO, en la fase 2, con contrato por
unidad. Las dos son correctas bajo esta regla, y ninguna lo era bajo la otra.

### Decisiones tomadas

| # | Decisión | Resultado |
|---|---|---|
| 1 | Regla de precio | El coste marginal decide. Tabla de arriba |
| 2 | ¿SEO se queda por web? | **Sí**, sin cambios |
| 3 | ¿Prospección multi-instancia? | **No.** Varias búsquedas en UN contrato — es la Fase B de Prospección, ya aplazada. Sale de este plan |
| 4 | ¿Un recado sabe de qué línea vino? | **Sí**, y se añade AHORA (ver abajo) |
| 5 | ¿Chatbot completo o por partes? | **Completo**, decisión del propietario: convertir un producto vivo es peor que construirlo entero con las tablas vacías |

### La decisión 4 es la única que pierde información si se aplaza

`Job` y `ServiceQuote` cuelgan de `contactId` y **no guardan ninguna
referencia a la línea** — comprobado: `Job` no tiene `callEventId` ni
`subscriptionId`. Con dos líneas, un recado no sabría de cuál vino, y **no hay
dato del que deducirlo después**. `Contact` sí se queda del cliente: quien
llama a tus dos negocios es una persona, no dos fichas.

Todas las demás decisiones son reversibles mientras producción siga vacía.

### El trabajo que queda

| Orden | Qué | Esfuerzo |
|---|---|---|
| 1 | **Recall multi-línea** — `RecallSubscription` ya lleva `clientProductId` y todo cuelga de `subscriptionId`, así que el modelo es casi gratis. El coste son los 29 archivos de test. Incluye la decisión 4 | 3-4 días |
| 2 | **Chatbot, completo** — esquema (4 tablas + el `@@unique([clientId])` de `TelegramConnection`, que es EL bloqueo real y es una línea), asistente por instancia, selector, bandeja, y sus 27 archivos de test | 2-2,5 sem |
| — | **Reseñas** | nada, ya está |
| — | **Prospección** | fuera de este plan → Fase B |

Unas **3 semanas**, frente a las 5 del reparto original.

### Lo que esto NO desbloquea

Ninguna de estas fases permite vender nada. Los bloqueos son externos y del
propietario: verificación como Tech Provider en Meta, los clientes OAuth de
Google, y la clave *live* de Stripe. Lo que aprovecha este trabajo es que hoy,
con producción vacía, es barato — y que deja de serlo en cuanto haya clientes.

## Estado — 19/09/2026

| Fase | Estado |
|---|---|
| 1 — el eje (`ClientSite`, anclas, autorización) | hecha |
| 2 — SEO por web | hecha |
| 3 — Recall por línea, con la decisión 4 | hecha |
| 4 — Chatbot completo | hecha, pendiente de fusionar |

### Qué hace la fase 4

- **Datos**: las siete tablas del chatbot (pasos del asistente, hitos,
  conocimiento y sus fragmentos, widget, resúmenes y su horario) llevan
  `clientProductId`, y sus claves únicas se mudaron de cliente a
  contratación. `TelegramConnection` pasa a una por chatbot.
- **Motor**: cada canal sabe de qué chatbot es (`resolveChatbotForChannel`);
  la configuración, el nombre con el que firma el bot, la tarifa de canales
  y la búsqueda en la base de conocimiento son las de ese chatbot.
- **Asistente**: versiones, aprobación, autoaprobación y paso a `ready` por
  chatbot; `?clientProductId=` en todas sus URLs (`lib/wizard-url.ts`).
- **Negocio de cada contratación** (`lib/client-site.ts`): todo cliente
  nace con sitio primario; la segunda contratación de un producto
  multi-instancia recibe su propio sitio al activarse, y el paso 1 aprobado
  le pone nombre y web.
- **Pantallas**: canales, conocimiento y resúmenes con selector
  (`ChatbotPicker`, que no se dibuja con un solo chatbot); la bandeja de
  traspaso sigue siendo una por cliente, con el chatbot en cada fila.
- **Avisos**: el barrido de asistente abandonado es por chatbot y el enlace
  del correo lleva a ese asistente.
- **Dos guardias estructurales**: `chatbot-instance-writers.test.ts` (todo
  `create` en tablas del chatbot lleva `clientProductId`) y
  `product-instance-authorization.test.ts` (toda ruta de un producto
  multi-instancia resuelve instancia), ambos sin pendientes.

### Límites aceptados, escritos donde se notan

- `ChatbotClient.state` sigue siendo un espejo por cliente para n8n
  (`wizard-review.ts`): con dos chatbots, el primero en llegar a `ready`
  mueve al cliente entero.
- Los flujos T+0/3/7/14 de n8n no mandan `clientProductId`: con dos
  chatbots, `/api/internal/activity` responde 409 hasta que lo hagan.
- El listado de conversaciones pasa por `listConversations`, que no
  devuelve la contratación: sigue siendo el del cliente, sin etiqueta.
- El panel de operador de SEO enseña la web más reciente (fase 2).
