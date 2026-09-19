import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { PRODUCT_CODES, getProductCatalog, type ProductCode } from './catalogs';
import { applySystemAutoApproval, WizardReviewError } from './wizard-review';
import { logError } from './observability';

// =============================================================================
// Fase 5 — "aprobar salvo veto" para los pasos de bajo riesgo del wizard.
//
// Del informe "Cadena de entrega por producto": el config-loader del bot
// solo lee versiones con `activeForBot: true`, y eso lo pone un operador.
// Un cliente podía completar los doce pasos y el bot no usar nada de ello
// hasta que alguien los revisara uno a uno — incluido "Horario", donde no
// hay nada que un operador esté juzgando mejor que el propio negocio.
//
// La propuesta no era quitar la revisión, era invertir el defecto: los
// pasos de bajo riesgo (Servicios y tarifas, FAQ, Horario —
// `autoApprovable` en el catálogo, src/lib/catalogs/chatbot.ts) se
// aprueban solos pasado un plazo si nadie los ha vetado; Personalidad y
// límites y Cumplimiento — donde sí hay juicio real que hacer — siguen
// exigiendo, siempre, a un operador.
//
// EL VETO ES `request_revision`, Y YA EXISTÍA. Un operador que revisa el
// paso y pulsa "solicitar cambios" lo saca de `submitted` antes de que
// este barrido lo mire; no hace falta ningún mecanismo nuevo para vetar,
// solo dejar de exigir la aprobación expresa cuando nadie lo hace.
//
// POR QUÉ 12 HORAS, NO 24: la SLA de revisión existente (el flujo n8n
// `config-review-overdue`, vía /api/internal/review-overdue/{scan,fire})
// avisa al operador a las 24h hábiles sin revisar y escala al CEO a las
// 48h — para CUALQUIER paso, de cualquier riesgo, porque hoy todos
// necesitan operador. Con la ventana de veto por debajo de ese umbral,
// un paso de bajo riesgo se aprueba solo antes de que esa SLA externa
// llegue siquiera a considerarlo "overdue" (una vez `approved`, deja de
// cumplir el `WHERE status = 'submitted'` del scan) — los dos mecanismos
// no compiten nunca por el mismo paso. Horas de reloj, no horas hábiles:
// a diferencia de esa SLA, aquí no hay a quién avisar si el plazo cae en
// fin de semana — el barrido simplemente aprueba, que es justo lo que
// libera al operador de tener que mirarlo.
//
// POR QUÉ ES UN CRON PROPIO DEL PORTAL Y NO PARTE DEL FLUJO DE N8N: ese
// flujo es orquestación EXTERNA — su fiabilidad depende de que alguien
// lo haya importado y esté corriendo, la misma categoría de "workflow
// que puede no existir todavía" que esta sesión encontró para tres
// productos completos. Aprobar un paso no puede depender de eso. El
// scheduler.sh que ya llama a cada /api/cron/* de este stack es la única
// pieza cuya fiabilidad SÍ está verificada esta sesión.
// =============================================================================

/** Ventana de veto: horas de reloj desde `submittedAt` sin que el paso
 *  salga de `submitted` (por aprobación manual o por `request_revision`)
 *  antes de que el sistema lo apruebe él solo. Ver el bloque de arriba
 *  para el porqué de 12 y no de otro número. */
export const AUTO_APPROVE_VETO_WINDOW_HOURS = 12;

const HOUR_MS = 60 * 60 * 1000;

/** El motivo que queda escrito, palabra por palabra, en el comentario de
 *  la fila de auditoría 'approve'. Exportado para que el sweep y sus
 *  tests compartan el mismo texto en vez de que cada uno lo reinvente. */
export function autoApprovalReason(): string {
  return (
    `Aprobación automática: paso de bajo riesgo sin veto del operador ` +
    `en ${AUTO_APPROVE_VETO_WINDOW_HOURS}h desde el envío.`
  );
}

/**
 * Cuándo se auto-aprobará este paso, si es que se va a auto-aprobar.
 *
 * `null` cubre tanto "nunca" (el paso no es de bajo riesgo) como "ahora
 * mismo no aplica" (no está `submitted`, o no tiene `submittedAt` — un
 * estado que no debería darse en un paso `submitted` de verdad, pero la
 * función no asume el invariante). Pura: la pantalla del operador la usa
 * para mostrar la cuenta atrás sin repetir esta lógica.
 */
export function computeAutoApproveDeadline(params: {
  autoApprovable: boolean;
  status: string;
  submittedAt: Date | null;
}): Date | null {
  if (!params.autoApprovable || params.status !== 'submitted' || !params.submittedAt) {
    return null;
  }
  return new Date(params.submittedAt.getTime() + AUTO_APPROVE_VETO_WINDOW_HOURS * HOUR_MS);
}

export interface WizardAutoApproveFailure {
  clientId: string | null;
  productCode: ProductCode;
  stepKey: string | null;
  error: string;
}

export interface WizardAutoApproveSweepResult {
  /** Pasos `submitted`, de bajo riesgo, más allá de la ventana — antes de
   *  intentar aprobarlos. */
  candidatesScanned: number;
  approved: number;
  /** El operador (o el propio cliente, re-editando) actuó entre que el
   *  barrido leyó la fila y que intentó escribirla. No es un fallo: es
   *  exactamente el veto funcionando. */
  skippedRace: number;
  failed: WizardAutoApproveFailure[];
}

const EMPTY_RESULT: WizardAutoApproveSweepResult = {
  candidatesScanned: 0,
  approved: 0,
  skippedRace: 0,
  failed: [],
};

/**
 * Un barrido completo, sobre todos los productos con pasos auto-
 * aprobables (solo 'chatbot' tiene alguno hoy — ver
 * `autoApprovableStepKeys` en src/lib/catalogs). Nunca lanza: aislado por
 * producto Y por paso, mismo criterio que el resto de los `sweep*` de
 * esta sesión — un fallo puntual no puede tumbar el resto del barrido.
 *
 * Seguro de llamar más veces de las que hace falta: la elegibilidad se
 * recalcula contra `submittedAt` en cada llamada, nunca contra la
 * cadencia del scheduler.
 */
export async function sweepAutoApprovableWizardSteps(
  prisma: PrismaClient,
  opts: { now?: Date } = {},
): Promise<WizardAutoApproveSweepResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - AUTO_APPROVE_VETO_WINDOW_HOURS * HOUR_MS);
  const result: WizardAutoApproveSweepResult = { ...EMPTY_RESULT, failed: [] };
  const reason = autoApprovalReason();

  for (const productCode of PRODUCT_CODES) {
    const autoApprovableStepKeys = getProductCatalog(productCode).autoApprovableStepKeys;
    if (autoApprovableStepKeys.length === 0) continue;

    let latestPerStep: {
      clientId: string;
      clientProductId: string | null;
      stepKey: string;
      status: string;
      submittedAt: Date | null;
    }[];
    try {
      // `distinct` + a matching `orderBy` is what makes this "the latest
      // version per (client, step)" rather than "every submitted row" —
      // a step whose latest version is a later, un-resubmitted DRAFT must
      // never be approved on the strength of an older submitted sibling.
      // The version-desc tiebreaker is what Prisma keeps per group.
      //
      // Fase 4 multi-instancia — el grupo es (cliente, CHATBOT, paso). Por
      // (cliente, paso), las versiones de dos chatbots del mismo cliente caían
      // en el mismo grupo y una escondía a la otra: el envío pendiente de un
      // chatbot no se habría aprobado nunca mientras el otro tuviera una
      // versión más reciente del mismo paso. El orderBy lleva el mismo
      // prefijo que el distinct, que es lo que Prisma exige para que el
      // "primero por grupo" sea el de mayor versión.
      latestPerStep = await prisma.chatbotConfigStep.findMany({
        where: { productCode, stepKey: { in: [...autoApprovableStepKeys] } },
        orderBy: [{ clientId: 'asc' }, { clientProductId: 'asc' }, { stepKey: 'asc' }, { version: 'desc' }],
        distinct: ['clientId', 'clientProductId', 'stepKey'],
        select: { clientId: true, clientProductId: true, stepKey: true, status: true, submittedAt: true },
      });
    } catch (err) {
      logError('wizard_auto_approve.scan_failed', err, { productCode }, 'warn');
      result.failed.push({
        clientId: null,
        productCode,
        stepKey: null,
        error: err instanceof Error ? err.message : 'unknown error',
      });
      continue;
    }

    for (const row of latestPerStep) {
      if (row.status !== 'submitted' || !row.submittedAt || row.submittedAt > cutoff) continue;
      result.candidatesScanned += 1;

      try {
        await applySystemAutoApproval(prisma, {
          clientId: row.clientId,
          productCode,
          stepKey: row.stepKey,
          // La aprobación desactiva la versión activa anterior DE ESTE
          // chatbot; sin esto buscaría entre los de todo el cliente.
          clientProductId: row.clientProductId,
          reason,
        });
        result.approved += 1;
      } catch (err) {
        if (err instanceof WizardReviewError && err.error.code === 'invalid_state_for_approve') {
          result.skippedRace += 1;
          continue;
        }
        logError(
          'wizard_auto_approve.step_failed',
          err,
          { clientId: row.clientId, productCode, stepKey: row.stepKey },
          'warn',
        );
        result.failed.push({
          clientId: row.clientId,
          productCode,
          stepKey: row.stepKey,
          error: err instanceof Error ? err.message : 'unknown error',
        });
      }
    }
  }

  return result;
}
