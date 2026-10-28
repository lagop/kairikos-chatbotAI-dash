# Imágenes de los borradores de web (A11)

Cada familia de sector tiene aquí su imagen de portada. La plantilla
(`src/lib/web-draft-html.ts`) las referencia por nombre fijo:

```
beauty.jpg        peluquerías, barberías, estética, uñas, spa
trades.jpg        fontanería, electricidad, reformas, cerrajería, taller
health.jpg        clínicas dentales, fisioterapia, veterinaria
food.jpg          restaurantes, cafeterías, panaderías
professional.jpg  abogados, asesorías, inmobiliarias, seguros
```

Las cinco están puestas (Unsplash, 1600×900, ~200-350 KB). Si un `.jpg` faltara, **la plantilla no se rompe**: cae a un degradado
generado con el color del sector (`<theme>.svg`, en esta misma carpeta), que
se ve digno aunque sin fotografía. Por eso se puede desplegar sin haber
elegido todavía las fotos.

## Fotos por oficio (`oficios/`, 28/10/2026)

Para oficios ya no hay una sola foto: hay tres por oficio en `oficios/`. Cada
negocio se queda con una, elegida primero por su nombre y luego por su tipo de
Google (`src/lib/trade-photos.ts`). Si no se reconoce el oficio, usa
`trades.jpg`, como antes. Los oficios elegidos son los que aparecían entre los
prospectos de producción ese día: la carpintería de aluminio era con mucho la
más frecuente.

Para añadir una foto: súbela como `<oficio>-<n>.jpg` y sube el número en
`TRADE_PHOTO_COUNTS`. Una prueba comprueba que estén todas y que ninguna pase
de 400 KB.

Todas son de Unsplash («Foto gratuita», licencia de Unsplash), descargadas a
1600 px de ancho el 28/10/2026:

| Archivo | Foto (unsplash.com/es/fotos/…) | Autor |
|---|---|---|
| fontaneria-1 | c314Gh8dXAo | Timur Shakerzianov |
| fontaneria-2 | C-oYJoIfgCs | Marian Florinel Condruz |
| fontaneria-3 | U0jpGKtMtWE | Immo Wegmann |
| electricidad-1 | PkHf7BUWbtk | Toolmash Expo |
| electricidad-2 | 47jO5Y8nsYo | mostafa mahmoudi |
| electricidad-3 | NAchd3UmxXo | Raymond Sime |
| reformas-1 | Te48TPzdcU8 | Milivoj Kuhar |
| reformas-2 | Re1O5byZ8bY | Sasun Bughdaryan |
| reformas-3 | f1kidLb-tw0 | asd asd |
| pintura-1 | 1iho4gvI4-g | Ali Mkumbwa |
| pintura-2 | RZc39x_CVjw | Frank Sobolewski |
| pintura-3 | ddzrK5r1N6o | Ravigopal Kesari |
| carpinteria-1 | p5JcD-_13ek | Ryno Marais |
| carpinteria-2 | KKY0GrQPqVo | HENG YIN |
| carpinteria-3 | GfYA6q5ESLI | Craft Kitties |
| cerrajeria-1 | ksbNqshFesY | Susan Holt Simpson |
| cerrajeria-2 | q7h8LVeUgFU | rc.xyz NFT gallery |
| cerrajeria-3 | XsJaBZtwhp4 | Derek Nelson |
| aluminio-1 | 8yT8YL-x8CQ | Alina Grubnyak |
| aluminio-2 | E8fXT092H5o | Fabian Kleiser |
| aluminio-3 | zKGL4LThrdE | Qian Shawn |
| solar-1 | rNn_TU8dvoY | Markus Spiske |
| solar-2 | wmaP3Tl80ww | Bill Mead |
| solar-3 | Ja8t8nJN2I4 | Watt A Lot |
| taller-1 | bEGTsOCnHro | Kate Ibragimova |
| taller-2 | xe-e69j6-Ds | Chad Kirchoff |
| taller-3 | 9gB7APNSquE | Sasun Bughdaryan |

## Qué foto poner

- Horizontal, mínimo 1600×900, menos de 400 KB (se sirve en móvil, por
  WhatsApp, a veces con mala cobertura).
- Del **oficio**, no del negocio: manos trabajando, herramientas, un local
  genérico. Nada de caras reconocibles ni de marcas visibles.
- Nunca una foto del prospecto ni de su competencia.

## De dónde salieron las actuales

Unsplash, descargadas el 23/09/2026 con la licencia de Unsplash: uso comercial
libre y sin atribución obligatoria. Se eligieron a ojo descartando dos: un
salón con una marca de producto repetida por toda la pared, y unas
herramientas sobre fondo negro que no dejaban leer el titular encima.

## De dónde sacar otras

Bancos con licencia de uso comercial y sin atribución obligatoria
(Unsplash, Pexels). **Descarga tú el archivo y súbelo aquí**: no se enlaza en
caliente a un banco externo, porque una portada que depende de un servidor
ajeno se queda en blanco el día que ese servidor falle, justo mientras
enseñas el borrador por teléfono.

## Lo que NO se usa

Las fotos de la ficha de Google del propio negocio. Son tentadoras —el dueño
vería su local en su web— pero las condiciones de uso de Places imponen
atribución y restringen mostrarlas fuera del contexto de Google. No compensa
el riesgo para una imagen de portada.

## Lo que se le dice al prospecto

La plantilla ya lo escribe en el pie: las imágenes son de muestra y en su web
irán las suyas. Decirlo además empuja a que entregue sus fotos, que es el
paso que luego bloquea las entregas.
