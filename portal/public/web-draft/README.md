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

Si un `.jpg` no está, **la plantilla no se rompe**: cae a un degradado
generado con el color del sector (`<theme>.svg`, en esta misma carpeta), que
se ve digno aunque sin fotografía. Por eso se puede desplegar sin haber
elegido todavía las fotos.

## Qué foto poner

- Horizontal, mínimo 1600×900, menos de 400 KB (se sirve en móvil, por
  WhatsApp, a veces con mala cobertura).
- Del **oficio**, no del negocio: manos trabajando, herramientas, un local
  genérico. Nada de caras reconocibles ni de marcas visibles.
- Nunca una foto del prospecto ni de su competencia.

## De dónde sacarlas

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
