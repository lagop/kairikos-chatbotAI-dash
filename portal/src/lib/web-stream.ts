// =============================================================================
// Un generador asíncrono de bytes convertido en el ReadableStream que espera
// la respuesta de Next. Nació en lib/cartera/zip.ts (el ZIP de la cartera) y
// se movió aquí el 25/11/2026 cuando las exportaciones RGPD del chat y de las
// llamadas necesitaron lo mismo: dos copias de esto se separan en silencio.
//
// `pull` y no `start`: el generador solo avanza cuando el navegador pide más,
// así que una exportación grande nunca está entera en memoria. Si el cliente
// cancela la descarga, `cancel` cierra el generador y con él el cursor que
// estuviera leyendo la base de datos.
// =============================================================================

/** Para la respuesta de Next: un ReadableStream que tira del generador. */
export function toWebStream(chunks: AsyncGenerator<Uint8Array>, onError?: (err: unknown) => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        onError?.(err);
        controller.error(err);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}
