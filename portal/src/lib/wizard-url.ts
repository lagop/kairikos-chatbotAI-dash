// =============================================================================
// Fase 4 multi-instancia — las URLs del asistente de configuración.
//
// Con varios chatbots, el asistente tiene que saber de cuál es cada paso, y
// eso viaja como `?clientProductId=` en todas sus URLs: páginas, redirecciones,
// enlaces de anterior/siguiente y llamadas a la API. Si un solo enlace lo
// pierde, el cliente aterriza en "¿de qué chatbot hablas?" a mitad de rellenar
// el asistente — o, peor, sin él la API se niega a guardar.
//
// Con un solo chatbot —todos los clientes de hoy— el parámetro no se añade y
// las URLs son exactamente las de siempre.
//
// Sin 'server-only' a propósito: lo usan también el componente de cliente
// del paso y sus enlaces. Es una función pura sobre cadenas.
// =============================================================================

export function withChatbot(path: string, clientProductId: string | null | undefined): string {
  if (!clientProductId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}clientProductId=${encodeURIComponent(clientProductId)}`;
}
