// =============================================================================
// El snippet que el cliente pega en su web (tarjeta «Web» de /portal/canales).
//
// 27/11/2026: carga embed.v2.js, no embed.js. El v1 está congelado y su
// formulario de contacto no tiene aviso ni casilla de consentimiento (la ruta
// de contacto lo cuenta como widget_contact.legacy_no_consent), así que un
// cliente nuevo que pegara el snippet de antes recogería teléfonos y correos
// sin el consentimiento que promete la Adenda del encargo del tratamiento.
// v2 acepta el mismo data-space-token y, sin más atributos, se ve como v1
// salvo el aviso de IA, el botón de cerrar, el panel a pantalla completa en
// móvil, botones de 44 px y el formulario con casilla (docs/widget-v2.md).
//
// Los clientes que ya pegaron el de v1 siguen con v1 hasta que cambien el
// suyo: embed.js no se toca.
//
// Sin imports de servidor: lo usa un componente de cliente.
// =============================================================================

export const WIDGET_SCRIPT_PATH = '/widget/embed.v2.js';

export function buildWidgetSnippet(origin: string, publicToken: string): string {
  return `<script src="${origin}${WIDGET_SCRIPT_PATH}" data-space-token="${publicToken}" async></script>`;
}
