# Reseñas Google en las webs Web Premium: feed por token

Las webs Web Premium (plantillas dental, estética y hotel) publican las reseñas reales de Google del cliente cuando tiene contratado **Reseñas Google** (`reviews`). La web es estática: se reconstruye sola **cada noche** en GitHub Actions (`publicar.yml` de cada plantilla, ver su `docs/publicacion.md`) y, al construir, lee este feed. El portal no lanza builds ni guarda nada de la web: solo sirve el feed y anota cuándo se leyó por última vez (decisión del propietario, 23/11/2026).

## Ruta pública

```
GET /api/public/resenas/rsf_<24 caracteres>/feed
```

| Respuesta | Cuándo | La web |
| --- | --- | --- |
| 200 | Token válido, ficha conectada y `reviews` contratado | Se publica con las reseñas |
| 404 | Token desconocido, con otra forma o retirado | La build falla y la web sigue como estaba |
| 410 | La ficha está desconectada o el cliente ya no tiene `reviews` | Se publica **sin** reseñas |
| 429 | Más de 30 lecturas por minuto del mismo token | La build falla (no debería pasar: una lectura por noche) |
| 503 / 500 | Sin base de datos / error | La build falla |

Cabeceras: `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `X-Content-Type-Options: nosniff`. Cada 200 actualiza `GoogleBusinessConnection.websiteFeedReadAt`.

Formato (versión 1, sin IA), el contrato de `docs/resenas.md` de las plantillas:

```json
{
  "version": 1,
  "syncedAt": "2026-11-23T03:10:00.000Z",
  "writeUrl": "https://g.page/r/…/review",
  "topics": [],
  "reviews": [
    {
      "id": "AbFvOq…",
      "author": "Marta G.",
      "rating": 5,
      "date": "2026-11-02T17:12:00.000Z",
      "lang": "es",
      "text": { "es": "…" },
      "reply": { "date": "2026-11-03T09:30:00.000Z", "text": { "es": "…" } },
      "featured": false
    }
  ]
}
```

- **Todas** las reseñas de la ficha, por fecha, también las de 1 y 2 estrellas. Sin comentario, la reseña va sin `text` (cuenta en la media, no sale como tarjeta).
- `text`: el original, sin la traducción que Google pega a veces («(Translated by Google) … (Original) …»). `lang` se detecta (`es`, `en`, `de`; si duda, `es`).
- `author`: nombre de pila e inicial; «Anónimo» si Google no da nombre.
- `reply`: solo la respuesta ya publicada en Google.
- Sin `summary`, `topics`, `treatment`, `concern`, `doctor`, `stay` ni traducciones: es la versión 2, con Claude. Las plantillas los tratan como opcionales.
- Las reseñas que han desaparecido de Google (`GoogleReview.removedAt`) no salen.

Código: `src/lib/review-feed-rules.ts` (puro: token, texto, idioma, feed, estado) y `src/lib/review-feed.ts` (base de datos). Ruta: `src/app/api/public/resenas/[token]/feed/route.ts`.

## Token

- `rsf_` + 18 bytes aleatorios en base64url. En la base de datos solo su SHA-256 (`GoogleBusinessConnection.websiteFeedTokenHash`, único). La URL completa se enseña **una sola vez**, al emitirla.
- Uno por ficha conectada. Emitir otro invalida el anterior (la web siguiente fallará con 404 hasta cambiar el secreto). Retirar lo borra.
- La URL va como secreto `REVIEWS_FEED_URL` del repositorio de la web en GitHub. Nunca en archivos del repositorio ni en el HTML.

## Panel del operador

Ficha del cliente (`/admin/portal/<clientId>`), producto Reseñas: bloque «Reseñas en la web» (`ReviewWebFeedPanel`), con una fila por ficha conectada y su estado:

| Estado | Qué significa |
| --- | --- |
| Sin enlace | No hay token |
| Sin leer | Hay token y la web no lo ha leído nunca |
| Al día | Leído hace menos de 36 horas |
| Atrasada | Más de 36 horas sin leerlo: la publicación nocturna está fallando o desactivada |

Botones «Emitir enlace» / «Emitir otro enlace» / «Retirar enlace». API: `POST /api/admin/portal/google-business/<connectionId>/web-feed` con `{ "action": "issue" | "revoke" }`, detrás de la sesión de administrador.

En el portal del cliente (`/portal/resenas`), una línea dice cuándo leyó la web sus reseñas por última vez.

## Reseñas borradas en Google

`syncGoogleReviews` anota los ids que ve en cada pasada. Solo si la pasada termina entera (todas las páginas) y ha visto alguna reseña, marca `removedAt` en las que ya no están (`markReviewsMissingFromSync`). Una pasada que falla a mitad o que no devuelve nada no marca ninguna. Si una reseña vuelve a aparecer, `removedAt` se limpia. La lista de `/portal/resenas` y el feed las ocultan.

Pendiente: `review-reputation` y `website-integrations` todavía cuentan las marcadas.

## Migración

`prisma/migrations/20261123120000_resenas_feed_web`: añade `website_feed_token_hash` (único) y `website_feed_read_at` a `GoogleBusinessConnection`, y `removed_at` a `GoogleReview`. Solo columnas nulas: se aplica sin parar el servicio.

## Alta de un cliente

Pasos en `docs/publicacion.md` de la plantilla. Lo que toca al portal: ficha de Google conectada y sincronizada, «Emitir enlace» y pegar la URL en `gh secret set REVIEWS_FEED_URL` del repositorio de la web. A la mañana siguiente, el estado pasa a «Al día».
