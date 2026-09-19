import 'server-only';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { ZodTypeAny } from 'zod';
import {
  CHATBOT_PRODUCT_CODE,
  WIZARD_STEP_CATALOG,
  normalizeTier,
  type WizardStepNumber,
  type WizardTier,
} from './wizard-catalog';
import { resolveClientStep } from './wizard-visibility';
import { jsonToObject } from './wizard-tier-prisma';
import {
  step1Schema,
  step2Schema,
  step3Schema,
  step4Schema,
  step5Schema,
  step6Schema,
  step7Schema,
  step9Schema,
  step10Schema,
} from './wizard-schemas';

// =============================================================================
// Fase 1.1 — el config-loader del bot.
//
// El cliente rellena 12 pasos del wizard, un operador los aprueba y se
// versionan... y hasta ahora al bot solo le llegaba el paso 9 (saludo,
// despedida y prompts sugeridos): las rutas /context no servían nada más.
// El comentario de ChatbotConfigStep en schema.prisma ya describía "el
// config-loader que el bot lee para construir sus prompts" — este archivo
// es ese cargador, que nunca se había escrito. Sin él, el bot no conoce
// los precios del cliente, ni sus FAQ, ni su horario, ni cuándo derivar a
// un humano, aunque el wizard pregunte por todo eso.
//
// Tres decisiones que NO son detalle de implementación:
//
//   1. Solo versiones con activeForBot — es decir, aprobadas por un
//      operador. Servir lo enviado-pero-no-revisado se saltaría la
//      revisión que el producto vende, y el bot diría cosas que nadie
//      validó.
//
//   2. Se aplica la visibilidad por tier, no se vuelcan las filas. Un
//      cliente starter tiene ocultos los pasos 3 (servicios y tarifas) y
//      7 (derivación), y el servidor debe sustituirlos por el
//      defaultPayload del catálogo — que justamente es
//      precio_tipo:'consultar' y fallback_sin_respuesta:'derivar'. Volcar
//      las filas tal cual dejaría a un bot de tier starter sin regla de
//      precios, improvisando. Eso ya lo resuelve resolveClientStep en
//      wizard-visibility.ts; aquí se reutiliza, no se reimplementa.
//
//   3. Un payload que no valida contra su esquema Zod se sirve como el
//      default del catálogo, no como null ni como un 500: el bot tiene
//      que poder seguir respondiendo aunque una fila esté corrupta.
//
// Los pasos 8 (canales), 11 (pruebas) y 12 (integraciones, aplazado) no
// se incluyen: no son configuración del comportamiento del bot.
// =============================================================================

/** Los pasos que sí describen cómo se comporta el bot, con el nombre
 *  bajo el que viajan al motor. El orden de esta lista es también el
 *  orden canónico con el que se calcula `configVersion`. */
const CONFIG_STEPS: ReadonlyArray<{
  number: WizardStepNumber;
  key: string;
  schema: ZodTypeAny;
}> = Object.freeze([
  { number: 1, key: 'perfil', schema: step1Schema },
  { number: 2, key: 'personalidad', schema: step2Schema },
  { number: 3, key: 'servicios', schema: step3Schema },
  { number: 4, key: 'faq', schema: step4Schema },
  { number: 5, key: 'horario', schema: step5Schema },
  { number: 6, key: 'captacion', schema: step6Schema },
  { number: 7, key: 'derivacion', schema: step7Schema },
  { number: 9, key: 'mensajes', schema: step9Schema },
  { number: 10, key: 'cumplimiento', schema: step10Schema },
]);

export interface BotConfigReadiness {
  /** true cuando no falta ningún paso requerido VISIBLE para el tier del
   *  cliente. Un paso que su tarifa oculta nunca cuenta como pendiente:
   *  el cliente no puede rellenarlo aunque quiera. */
  ready: boolean;
  /** stepKeys requeridos, visibles para su tier, sin versión aprobada. */
  missingRequired: string[];
}

export interface BotConfig {
  /** Hash corto del contenido. Cambia al aprobarse cualquier paso y NO
   *  cambia entre dos llamadas sin cambios, para que el motor pueda
   *  cachear sin pedir esto en cada turno de conversación. */
  configVersion: string;
  tier: WizardTier | null;
  perfil: Record<string, unknown>;
  personalidad: Record<string, unknown>;
  servicios: Record<string, unknown>;
  faq: Record<string, unknown>;
  horario: Record<string, unknown>;
  captacion: Record<string, unknown>;
  derivacion: Record<string, unknown>;
  mensajes: Record<string, unknown>;
  cumplimiento: Record<string, unknown>;
  readiness: BotConfigReadiness;
}

/** Serialización con orden de claves estable a cualquier profundidad —
 *  `JSON.stringify` respeta el orden de inserción, que puede variar
 *  entre una fila leída de Postgres y otra reconstruida desde el
 *  catálogo. Sin esto, `configVersion` cambiaría sin que cambie nada. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export function computeConfigVersion(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex').slice(0, 12);
}

/**
 * Construye la configuración completa del bot para un cliente, a partir
 * de las versiones aprobadas de su wizard.
 *
 * Una sola consulta a ChatbotConfigStep: el índice único parcial sobre
 * (clientId, productCode, stepKey) WHERE activeForBot garantiza como
 * mucho una fila activa por paso, así que no hace falta ordenar ni
 * desduplicar aquí.
 */
/** Fase 4 multi-instancia — de qué chatbot es la configuración. */
export interface BotInstanceRef {
  clientProductId: string;
  /** La tarifa de ESA contratación (Product.tier), no la del cliente. */
  tier: string;
  /** El negocio al que pertenece, para firmar con SU nombre. */
  clientSiteId?: string | null;
}

export async function buildBotConfig(
  prisma: PrismaClient,
  clientId: string,
  instance?: BotInstanceRef | null,
): Promise<BotConfig> {
  const [client, activeRows] = await Promise.all([
    prisma.chatbotClient.findUnique({ where: { id: clientId }, select: { tier: true } }),
    prisma.chatbotConfigStep.findMany({
      where: {
        clientId,
        productCode: CHATBOT_PRODUCT_CODE,
        activeForBot: true,
        // Fase 4 multi-instancia — los pasos aprobados de ESTE chatbot. Sin
        // esto, con dos chatbots el bot de un negocio se configuraría con los
        // horarios y el tono del otro.
        ...(instance ? { clientProductId: instance.clientProductId } : {}),
      },
      select: { stepKey: true, payload: true },
    }),
  ]);

  // Fase 4 multi-instancia — la tarifa sale de la contratación cuando se
  // conoce. ChatbotClient.tier es un campo del CLIENTE: con un Starter y un
  // Premium, los dos bots habrían funcionado como uno solo de los dos. Se
  // queda como respaldo para el camino que no conoce la instancia.
  const tier = normalizeTier(instance?.tier ?? client?.tier ?? null);
  const activeByStep = new Map(activeRows.map((row) => [row.stepKey, row.payload]));

  const blocks: Record<string, Record<string, unknown>> = {};
  const missingRequired: string[] = [];

  for (const step of CONFIG_STEPS) {
    const definition = WIZARD_STEP_CATALOG[step.number];
    const rawPayload = jsonToObject(activeByStep.get(definition.key) ?? null);

    // Un payload corrupto se trata como "sin guardar": resolveClientStep
    // devuelve entonces el default del catálogo, en vez de propagar basura
    // al prompt del bot.
    const isValid = rawPayload !== null && step.schema.safeParse(rawPayload).success;
    const savedPayload = isValid ? rawPayload : null;

    const resolved = resolveClientStep(
      step.number,
      tier,
      { hasSavedVersion: savedPayload !== null },
      savedPayload,
    );
    blocks[step.key] = resolved.effectivePayload ?? {};

    // Solo cuenta como pendiente si el cliente PUEDE rellenarlo: un paso
    // que su tarifa oculta ya viene resuelto por el default del catálogo.
    const visibleForTier = definition.visibleFor(tier);
    if (definition.requiredForReady && visibleForTier && savedPayload === null) {
      missingRequired.push(definition.key);
    }
  }

  const configVersion = computeConfigVersion({ tier, blocks });

  return {
    configVersion,
    tier,
    perfil: blocks.perfil,
    personalidad: blocks.personalidad,
    servicios: blocks.servicios,
    faq: blocks.faq,
    horario: blocks.horario,
    captacion: blocks.captacion,
    derivacion: blocks.derivacion,
    mensajes: blocks.mensajes,
    cumplimiento: blocks.cumplimiento,
    readiness: { ready: missingRequired.length === 0, missingRequired },
  };
}

export interface ChatbotContext {
  businessName: string;
  welcomeMessage: string;
  farewellMessage: string | null;
  suggestedPrompts: string[];
  config: BotConfig;
}

/**
 * Lo que devuelven las cinco rutas /api/internal/channels/*\/context, sin
 * el `clientId` (que cada ruta ya resolvió desde el identificador de su
 * plataforma) ni los campos propios del canal.
 *
 * Los cuatro campos de arriba existían antes de que hubiera config-loader
 * y se mantienen byte a byte, con sus mismos valores por defecto: puede
 * haber workflows de n8n leyéndolos hoy, y romperlos silenciaría al bot
 * en producción. Lo nuevo viaja bajo `config`.
 */
export async function buildChatbotContext(
  prisma: PrismaClient,
  clientId: string,
  instance?: BotInstanceRef | null,
): Promise<ChatbotContext> {
  const [client, config, site] = await Promise.all([
    prisma.chatbotClient.findUnique({
      where: { id: clientId },
      select: { companyName: true, name: true },
    }),
    buildBotConfig(prisma, clientId, instance),
    // Fase 4 multi-instancia — el bot firma con el nombre de SU negocio. Con
    // dos, el nombre del cliente es el de la empresa, no el de la clínica o
    // el taller que atiende este bot. Para los clientes de hoy es el mismo
    // texto: el backfill de la fase 1 creó cada sitio con el nombre de la
    // empresa.
    instance?.clientSiteId
      ? prisma.clientSite.findUnique({ where: { id: instance.clientSiteId }, select: { name: true } })
      : Promise.resolve(null),
  ]);

  const mensajes = step9Schema.safeParse(config.mensajes);

  return {
    businessName: site?.name?.trim() || client?.companyName || client?.name || 'nuestro negocio',
    welcomeMessage: mensajes.success ? mensajes.data.mensaje_bienvenida : '¡Hola! ¿En qué puedo ayudarte?',
    farewellMessage: mensajes.success ? (mensajes.data.mensaje_despedida ?? null) : null,
    suggestedPrompts: mensajes.success ? mensajes.data.prompts_sugeridos : [],
    config,
  };
}
