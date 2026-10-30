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

Para oficios ya no hay una sola foto: hay ocho por oficio en `oficios/`: tres de portada y cinco para las pestañas. Cada
negocio se queda con una de portada, elegida primero por su nombre y luego por su tipo de
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

### Las de las pestañas (`<oficio>-4` a `-8`, 28/10/2026)

Las tres primeras de cada oficio son de **portada** y no se mezclan con estas: si la portada eligiera entre las ocho, cambiaría la de los borradores que ya se han enseñado (`TRADE_HERO_PHOTOS` en `trade-photos.ts`). Estas cinco van en las pestañas de «Qué incluye cada servicio», así que ninguna pestaña repite la de portada.

Mismo criterio y misma licencia. Se descartaron siete al revisarlas a 1600 px por llevar una marca legible: magnetotérmicos ABB, el logo de BMW en una llanta, un candado SQUIRE, un taladro Makita, un cartucho de silicona, una herramienta y el texto de un guante. Las cinco que pesaban más de 400 KB se pidieron con más compresión (q=50–60).

| Archivo | Foto (unsplash.com/es/fotos/…) | Autor |
|---|---|---|
| aluminio-4 | ysgELOy_t0c | Alex Perz |
| aluminio-5 | QmiR1c9azJY | Declan Sun |
| aluminio-6 | iQ9_1cVOwiQ | Adam Elwan |
| aluminio-7 | u-9dA84J0iI | Yingying LI |
| aluminio-8 | oRm2TfiHG0U | Ricardo Resende |
| solar-4 | 6M9OhcblUHM | Mischa Frank |
| solar-5 | VAegToqdX3A | Sergio Martins |
| solar-6 | 2ASQyjafflo | Evgeniy Alyoshin |
| solar-7 | zWL_sYw10gs | Sergej ***** |
| solar-8 | 8GS8bmor8_A | Watt A Lot |
| fontaneria-4 | jaP5ClBdIyU | bhagya laxmi |
| fontaneria-5 | HIBdxZQzA2Q | Supply |
| fontaneria-6 | 1N5jjLyBafc | Alexander Schimmeck |
| fontaneria-7 | scUBcasSvbE | Samuel Sianipar |
| fontaneria-8 | 4CNNH2KEjhc | Compagnons |
| electricidad-4 | NLBJ2I0lNr4 | Hobi industri |
| electricidad-5 | KDkU44ikiko | Raymond Sime |
| electricidad-6 | kXC6XhVL1e4 | Troy Bridges |
| electricidad-7 | 7XaBaKwrV1E | intrapixel |
| electricidad-8 | nt5Tjdg-9ks | Troy Bridges |
| cerrajeria-4 | nvYIrRZAFgg | Arkadiusz Gąsiorowski |
| cerrajeria-5 | nAZUJFrDlaY | Jorien Loman |
| cerrajeria-6 | 7tkDoo2L_Eg | Jaye Haych |
| cerrajeria-7 | oW-Sx33bYJk | Pawel Czerwinski |
| cerrajeria-8 | tVIv23vcuz4 | Jan Tinneberg |
| carpinteria-4 | v13x0qU4afA | Adam Patterson |
| carpinteria-5 | HjFUevA2g1k | Nico Smit |
| carpinteria-6 | S-lveyCLmHw | Ryno Marais |
| carpinteria-7 | DfffcjQ106U | Bailey Alexander |
| carpinteria-8 | pxybw_7H9Gg | Ryno Marais |
| taller-4 | Fd6osyVbtG4 | Christian Buehner |
| taller-5 | Y_t0n-T4H5M | Nina Mercado |
| taller-6 | K5624F8cipE | Tahamie Farooqui |
| taller-7 | xFjti9rYILo | Garett Mizunaka |
| taller-8 | KhF58h0hTbc | Kato Blackmore |
| pintura-4 | Cl-OpYWFFm0 | Theme Photos |
| pintura-5 | rMVjOX8nm2U | Andrew Itaga |
| pintura-6 | 8VH4BXkXCkU | Hugo Clément |
| pintura-7 | DzPDs5UdnOw | Wilhelm Gunkel |
| pintura-8 | ioOlenqfMqA | Flow Clark |
| reformas-4 | UqNEbyRQ660 | immo RENOVATION |
| reformas-5 | biRt6RXejuk | Stefan Lehner |
| reformas-6 | K5sjajgbTFw | Nolan Issac |
| reformas-7 | g51F6-WYzyU | Lotus Design N Print |
| reformas-8 | MP0bgaS_d1c | Naomi Hébert |

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

## Belleza (`belleza/`, 28/10/2026)

Para peluquerías y barberías: los 16 prospectos de belleza de ese día eran
peluquerías (alguna también barbería). Dos usos:

- **Portada** (`peluqueria-1..3`, `barberia-1..2`): como las de oficios, por el
  nombre o el tipo de Google (`trade-photos.ts`). Estética, uñas y spa siguen
  con `beauty.jpg`.
- **Bloques de ejemplo** del borrador (`trabajo-1..9`, `despues-1`): la galería,
  las pestañas de servicios y el antes y después que trae el borrador de una
  peluquería (`site-sector-blocks.ts`). Van marcados como datos de ejemplo:
  no se publican hasta que el cliente los cambia o los confirma, y al publicar
  viajan con la web (`assets/muestra/`).

Todas de Unsplash («Foto gratuita»), a 1600 px, sin caras reconocibles,
descargadas con permiso de Orlando el 28/10/2026:

| Archivo | Foto (unsplash.com/es/fotos/…) | Autor |
|---|---|---|
| peluqueria-1 | gI9rvJK61L8 | Giorgio Trovato |
| peluqueria-2 | T9u-Xr30FY8 | Giorgio Trovato |
| peluqueria-3 | wSpkThmoZQc | Giorgio Trovato |
| barberia-1 | EW_rqoSdDes | Nathon Oski |
| barberia-2 | 1_DAlXy0wng | André Reis |
| trabajo-1 | Re6pyBDuCAo | Charlotte Malene |
| trabajo-2 | Obi1yM7KLqU | Alina Chernovolova |
| trabajo-3 | tOUcSRABuRI | Daniel Miksha |
| trabajo-4 | TBmNnhIFDeg | Paloma LaMadreInspirada |
| trabajo-5 | NYpC-nLLxQw | mayank sharma |
| trabajo-6 | D_1tyuWWbeY | Kimia Zarifi |
| trabajo-7 | gWGgfIUNFuA | Chloe Zeller |
| trabajo-8 | pu20JkUx--A | Arthur Humeau |
| trabajo-9 | TnyHlxVnyhk | Giselle Lazcano |
| despues-1 | GO1d_3tqkFo | Yovanka Loria Salon |

## Salud (`salud/`, 30/10/2026)

Para clínicas dentales, fisioterapia, veterinaria y consultas médicas. Ese día
no había ni un prospecto del sector: se eligieron por lo que Google mete en la
familia `health`. Cada negocio se queda con una de portada, por el nombre y
luego por el tipo de Google (`trade-photos.ts`); si no se reconoce, una de
consulta genérica (`clinica-*`), no `health.jpg`.

Aquí **sí salen personas**, a diferencia de oficios: una consulta vacía parece
cerrada. Son modelos de banco, nunca el personal del prospecto.

Todas de Unsplash («Foto gratuita»), a 1600 px, descargadas con permiso de
Orlando el 30/10/2026. Las cuatro que pasaban de 400 KB se recomprimieron
(q=74–80).

| Archivo | Foto (unsplash.com/es/fotos/…) | Autor |
|---|---|---|
| dental-1 | Bg81yWKZlMg | Harold Hisona |
| dental-2 | e7MJLM5VGjY | Benyamin Bohlouli |
| dental-3 | XJptUS8nbhs | Atikah Akhtar |
| dental-4 | 44jaETSVX2I | Katarzyna Zygnerska |
| dental-5 | AWqHc49SU-c | Ozkan Guner |
| fisioterapia-1 | pbUWW-CBoqY | yury kirillov |
| fisioterapia-2 | ZzkNkbUxFMc | Julius Toltesi |
| fisioterapia-3 | vIb5HzilzBs | Julius Toltesi |
| fisioterapia-4 | UNRW1dD2xjI | yury kirillov |
| fisioterapia-5 | E0xu1n9yiPk | Vitaly Gariev |
| veterinaria-1 | e4f87NzUJsU | Alexander Mass |
| veterinaria-2 | 5Bi6MWlWMbw | Judy Beth Morris |
| veterinaria-3 | I3KxEBS6iOc | Alexander Mass |
| veterinaria-4 | sdpIuIbKaQg | Alexander Mass |
| veterinaria-5 | u2H8mUzoF2Q | Anya Prygunova |
| clinica-1 | XqMo4OlBnh0 | Vitaly Gariev |
| clinica-2 | 8WYkI3cEZm8 | Vitaly Gariev |
| clinica-3 | 2kopEHjST-g | Vitaly Gariev |
| clinica-4 | 6qN9yEK5k9U | Vitaly Gariev |
