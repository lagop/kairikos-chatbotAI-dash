# Fase 1 — el eje multi-instancia

> Estado: propuesta, sin empezar. Escrito el 18 de septiembre de 2026, antes de
> vender en producción. Ese "antes" es la premisa entera del plan: no hay datos
> de clientes que migrar, así que se puede cambiar la columna por la que se
> identifica media base de datos. Con un solo cliente vivo, este documento
> habría que reescribirlo.

## El problema

Un cliente no puede contratar dos veces el mismo producto. SEO para dos webs,
un chatbot por cada negocio, Reseñas para dos fichas: nada de eso se puede
vender hoy. El bloqueo está en dos sitios, coherentemente:

- `createProductCheckoutSession` devuelve `409 already_contracted` cuando el
  producto ya está activo (`stripe-billing.ts`).
- El alta manual de operador reutiliza la fila existente en vez de crear otra
  (`client-product-activation.ts`), con una única excepción explícita:
  `product.code === 'web' ? null : findFirst(...)`.

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

## `listContractedProducts` deja de mentir

```ts
// Hoy, en client-product-access.ts:
//   "deduped by product code (a client should not have two active rows
//    for the same code, but this defends against the data drift...)"
```

Ese dedup es precisamente la premisa que este plan invalida. Pasa a devolver una
fila por **instancia**, con su sitio, y el selector de productos agrupa por
sitio. Es el único llamante existente que cambia de semántica en la fase 1, y
por eso va en esta fase y no en las siguientes: es el que dibuja el menú.

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
2. **Test de guarda estructural** — el patrón que este repo ya usa para
   `KAIRIKOS_OPERATOR_EMAILS`: lee el código fuente, quita los comentarios, y
   falla si una ruta bajo `/api/portal/*` que escribe (POST/PATCH/DELETE)
   autoriza con `isProductContracted` en vez de `resolveContractedInstance`.
   Con su "guarda de la guarda": un caso que confirma que el test detecta una
   violación introducida a propósito.
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

## Después

| Fase | Qué | Esfuerzo |
|---|---|---|
| 2 | SEO — su perfil ya está bien; las tablas operativas son autocontenidas. `GoogleSeoConnection.clientId` y `GoogleAnalyticsConnection.clientId` son `@unique`: hay que quitar esa restricción | 1 sem |
| 3 | Reseñas y Recall — por ficha de Google y por línea telefónica | 1,5 sem |
| 4 | Prospección | 3-4 días |
| 5 | Chatbot, y `Lead` filtrado por sitio — el más profundo, y del que cuelgan los demás | 2-3 sem |
