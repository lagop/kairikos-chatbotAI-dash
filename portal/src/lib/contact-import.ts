import 'server-only';
import type { PrismaClient, Prisma } from '@prisma/client';
import { parseCsvTable, normaliseHeader } from './csv';
import { normaliseE164 } from './recall-blocklist';

// =============================================================================
// Fase 4 — importar la base de datos que el cliente ya tiene.
//
// DOS FUNCIONES CON PROPÓSITOS MUY DISTINTOS:
//
//   analyseImport()  lee el fichero, lo puntúa y NO ESCRIBE NADA.
//   (commitImport vive en la mitad de abajo y sí escribe)
//
// La primera es, además de la vista previa, la HERRAMIENTA DE VENTA: el
// prospecto sube su export y ve su propio dinero antes de firmar nada.
// "1.240 clientes, 380 sin contacto en más de 18 meses, 94 presupuestos
// abiertos por 61.000 €". Por eso funciona sin cliente, sin suscripción y
// sin tocar la base: tiene que poder ejecutarse en una llamada comercial.
//
// DE DÓNDE SALE EL FICHERO, QUE NO ES OBVIO. La mejor fuente no suele ser
// un CRM sino el SISTEMA DE FACTURACIÓN: todo profesional factura, no
// todos usan CRM. Y el registro de facturación acredita justo las dos
// condiciones del soft opt-in — que fueran clientes reales y qué
// servicio compraron. Por eso el mapeo de columnas de abajo reconoce los
// nombres que usan los programas de facturación españoles.
//
// LA PUNTUACIÓN DE CALIDAD NO ES DECORACIÓN: es un filtro comercial. Una
// base con el 30% de teléfonos válidos no se puede trabajar, y saberlo
// ANTES de firmar evita vender un servicio que no se va a poder prestar.
// =============================================================================

/**
 * Nombres de columna que se reconocen solos, por campo.
 *
 * Ordenados de más específico a más genérico: 'telefono_movil' antes que
 * 'telefono', porque si un export trae los dos, el móvil es el que tiene
 * WhatsApp. El primero que case, gana.
 */
const COLUMN_ALIASES: Record<string, readonly string[]> = {
  phone: ['telefono_movil', 'movil', 'celular', 'mobile', 'telefono', 'tel', 'phone', 'telefono_1'],
  name: ['nombre_cliente', 'cliente', 'nombre', 'razon_social', 'name', 'customer', 'titular'],
  email: ['email', 'correo', 'correo_electronico', 'e_mail', 'mail'],
  lastServiceAt: ['fecha_ultimo_servicio', 'ultimo_servicio', 'fecha_factura', 'fecha', 'date', 'fecha_trabajo'],
  serviceType: ['servicio', 'concepto', 'descripcion', 'trabajo', 'service'],
  amount: ['importe', 'total', 'base_imponible', 'amount', 'precio', 'importe_total'],
  nextServiceAt: ['proxima_revision', 'proximo_servicio', 'vencimiento', 'next_service'],
  address: ['direccion', 'domicilio', 'address', 'calle'],
};

export type ImportField = keyof typeof COLUMN_ALIASES;

/**
 * Adivina qué columna del fichero es cada campo.
 *
 * Devuelve el mapeo para que una PERSONA lo corrija: adivinar bien el 80%
 * ahorra el trabajo, y presentarlo como definitivo lo estropea. Un export
 * con una columna "fecha" que en realidad es la fecha de alta y no la del
 * último servicio no lo puede distinguir ningún heurístico.
 */
export function guessColumnMapping(headers: readonly string[]): Partial<Record<ImportField, string>> {
  const present = new Set(headers.map(normaliseHeader));
  const mapping: Partial<Record<ImportField, string>> = {};
  const taken = new Set<string>();

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [ImportField, readonly string[]][]) {
    for (const alias of aliases) {
      if (present.has(alias) && !taken.has(alias)) {
        mapping[field] = alias;
        taken.add(alias);
        break;
      }
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Normalización de celdas
// ---------------------------------------------------------------------------

/**
 * Lee un importe escrito como lo escribe un español.
 *
 * "1.400,50 €" son mil cuatrocientos con cincuenta, no uno coma cuatro.
 * Es el error que hace que una base de 61.000 € se muestre como 61 €, y
 * pasa desapercibido porque el número sigue pareciendo un número.
 *
 * La regla: si hay coma Y punto, el ÚLTIMO es el decimal. Si solo hay
 * coma, es decimal. Si solo hay punto y quedan exactamente tres cifras
 * detrás, es separador de miles.
 */
export function parseAmount(raw: string): number | null {
  const clean = raw.replace(/[^\d.,-]/g, '').trim();
  if (!clean) return null;

  const lastComma = clean.lastIndexOf(',');
  const lastDot = clean.lastIndexOf('.');

  let normalised: string;
  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandsSep = decimalSep === ',' ? '.' : ',';
    normalised = clean.split(thousandsSep).join('').replace(decimalSep, '.');
  } else if (lastComma >= 0) {
    normalised = clean.replace(',', '.');
  } else if (lastDot >= 0 && clean.length - lastDot - 1 === 3) {
    // "1.400" son mil cuatrocientos, no uno coma cuatro.
    normalised = clean.split('.').join('');
  } else {
    normalised = clean;
  }

  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

/**
 * Lee una fecha escrita como la escribe un programa español.
 *
 * DD/MM/AAAA va PRIMERO, y es la decisión importante de esta función: el
 * `new Date()` de JavaScript lee "03/04/2026" como el 4 de marzo, y en un
 * export español es el 3 de abril. Un mes de diferencia en la fecha del
 * último servicio desplaza todos los recordatorios de revisión.
 *
 * Las ambiguas de verdad (día ≤ 12 en los dos sitios) se resuelven a la
 * española porque el fichero lo es; las imposibles (día > 12 en segunda
 * posición) delatan formato americano y se leen como tal.
 */
export function parseImportDate(raw: string): Date | null {
  const clean = raw.trim();
  if (!clean) return null;

  const dmy = clean.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dmy) {
    let [, a, b, y] = dmy;
    let day = Number(a);
    let month = Number(b);
    // Segunda posición > 12: no puede ser un mes, así que era MM/DD.
    if (month > 12 && day <= 12) [day, month] = [month, day];
    if (month > 12 || day > 31) return null;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    const date = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // ISO y todo lo demás, que el parser nativo sí lee bien.
  const iso = clean.match(/^\d{4}-\d{2}-\d{2}/);
  if (iso) {
    const date = new Date(clean);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** Validación de email deliberadamente floja: aquí solo sirve para
 *  puntuar la calidad y no para autenticar a nadie, y una expresión
 *  regular estricta rechaza direcciones válidas raras pero reales. */
export function looksLikeEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw.trim());
}

// ---------------------------------------------------------------------------
// El análisis
// ---------------------------------------------------------------------------

export interface ImportRow {
  rowNumber: number;
  e164: string | null;
  name: string | null;
  email: string | null;
  lastServiceAt: Date | null;
  serviceType: string | null;
  amount: number | null;
  nextServiceAt: Date | null;
  /** Por qué esta fila no se puede importar. Null = se puede. */
  skipReason: 'no_phone' | 'invalid_phone' | null;
}

export interface QualityScore {
  totalRows: number;
  /** Filas con teléfono utilizable. Sin esto no hay nada que hacer. */
  withValidPhone: number;
  withName: number;
  withValidEmail: number;
  withDate: number;
  withAmount: number;
  /** Duplicados DENTRO del propio fichero, ya deduplicados por E.164. */
  duplicatesInFile: number;
  /** 0-100. Ver computeQualityScore para qué pondera. */
  score: number;
}

export interface ImportDiagnostic {
  /** Contactos únicos e importables. */
  usableContacts: number;
  /** Sin servicio en más de 18 meses: la bolsa de recuperación. */
  dormantContacts: number;
  /** Revisiones ya vencidas según el propio fichero. */
  overdueServices: number;
  /** Suma de los importes leídos, para enseñarle su propio dinero. */
  totalBilled: number;
}

export interface ImportAnalysis {
  mapping: Partial<Record<ImportField, string>>;
  rows: ImportRow[];
  quality: QualityScore;
  diagnostic: ImportDiagnostic;
  /** Las primeras filas, para que una persona confirme el mapeo. */
  preview: ImportRow[];
}

const PREVIEW_ROWS = 5;
const DORMANT_MONTHS = 18;

/**
 * La nota de 0 a 100.
 *
 * EL TELÉFONO PESA LA MITAD, y no es arbitrario: sin teléfono válido un
 * contacto no se puede recuperar por ningún canal de este producto, así
 * que una base preciosa con el 20% de teléfonos sigue sin servir. El
 * resto se reparte entre lo que hace el mensaje PERSONAL —nombre y fecha—
 * y lo que permite priorizar —importe—.
 */
export function computeQualityScore(q: Omit<QualityScore, 'score'>): number {
  if (q.totalRows === 0) return 0;
  const pct = (n: number) => n / q.totalRows;
  const score =
    pct(q.withValidPhone) * 50 +
    pct(q.withName) * 20 +
    pct(q.withDate) * 20 +
    pct(q.withAmount) * 10;
  return Math.round(score);
}

/**
 * Lee un CSV y dice qué hay dentro. NO ESCRIBE NADA.
 *
 * Funciona sin cliente ni suscripción a propósito: es la herramienta de
 * venta, y tiene que poder ejecutarse sobre el fichero de un prospecto
 * que todavía no es cliente de nada. Ver la cabecera.
 */
export function analyseImport(
  csvText: string,
  opts: { mapping?: Partial<Record<ImportField, string>>; now?: Date } = {},
): ImportAnalysis {
  const now = opts.now ?? new Date();
  const table = parseCsvTable(csvText);
  const mapping = opts.mapping ?? guessColumnMapping(table.headers);

  const cell = (row: Record<string, string>, field: ImportField): string => {
    const column = mapping[field];
    return column ? (row[column] ?? '').trim() : '';
  };

  const seen = new Set<string>();
  let duplicatesInFile = 0;

  const rows: ImportRow[] = table.rows.map((raw, index) => {
    const phoneRaw = cell(raw, 'phone');
    const e164 = phoneRaw ? normaliseE164(phoneRaw) : null;

    let skipReason: ImportRow['skipReason'] = null;
    if (!phoneRaw) skipReason = 'no_phone';
    else if (!e164) skipReason = 'invalid_phone';

    if (e164) {
      if (seen.has(e164)) duplicatesInFile += 1;
      seen.add(e164);
    }

    const emailRaw = cell(raw, 'email');

    return {
      rowNumber: index + 2, // +2: la 1 es la cabecera y las hojas empiezan en 1.
      e164,
      name: cell(raw, 'name') || null,
      email: emailRaw && looksLikeEmail(emailRaw) ? emailRaw : null,
      lastServiceAt: parseImportDate(cell(raw, 'lastServiceAt')),
      serviceType: cell(raw, 'serviceType') || null,
      amount: parseAmount(cell(raw, 'amount')),
      nextServiceAt: parseImportDate(cell(raw, 'nextServiceAt')),
      skipReason,
    };
  });

  const base: Omit<QualityScore, 'score'> = {
    totalRows: rows.length,
    withValidPhone: rows.filter((r) => r.e164 !== null).length,
    withName: rows.filter((r) => r.name !== null).length,
    withValidEmail: rows.filter((r) => r.email !== null).length,
    withDate: rows.filter((r) => r.lastServiceAt !== null).length,
    withAmount: rows.filter((r) => r.amount !== null).length,
    duplicatesInFile,
  };

  const dormantCutoff = new Date(now.getTime());
  dormantCutoff.setMonth(dormantCutoff.getMonth() - DORMANT_MONTHS);

  // Sobre contactos ÚNICOS, no sobre filas: un cliente con doce facturas
  // es un cliente, y contarlo doce veces infla el diagnóstico de venta
  // justo en la dirección que nos conviene. Eso se nota en la primera
  // reunión y cuesta la venta entera.
  //
  // Y SOLO SOBRE CONTACTOS ALCANZABLES. Las filas sin teléfono utilizable
  // quedan fuera de todo, incluido `totalBilled`. Es dinero que el
  // profesional facturó de verdad, pero no es dinero sobre el que este
  // producto pueda hacer nada — y en un número que se enseña en una
  // llamada de venta, el error hay que cometerlo siempre hacia abajo.
  const byContact = new Map<string, ImportRow[]>();
  for (const row of rows) {
    if (!row.e164) continue;
    const list = byContact.get(row.e164) ?? [];
    list.push(row);
    byContact.set(row.e164, list);
  }

  let dormantContacts = 0;
  let overdueServices = 0;
  let totalBilled = 0;

  for (const entries of byContact.values()) {
    const dates = entries.map((e) => e.lastServiceAt).filter(Boolean) as Date[];
    const mostRecent = dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;
    if (mostRecent && mostRecent < dormantCutoff) dormantContacts += 1;

    const dues = entries.map((e) => e.nextServiceAt).filter(Boolean) as Date[];
    if (dues.some((d) => d < now)) overdueServices += 1;

    for (const entry of entries) totalBilled += entry.amount ?? 0;
  }

  return {
    mapping,
    rows,
    quality: { ...base, score: computeQualityScore(base) },
    diagnostic: {
      usableContacts: byContact.size,
      dormantContacts,
      overdueServices,
      totalBilled: Math.round(totalBilled * 100) / 100,
    },
    preview: rows.slice(0, PREVIEW_ROWS),
  };
}

/**
 * El resumen en una frase, que es como se enseña en una llamada de venta.
 *
 * No promete nada: le enseña sus propios números. Esa es toda la técnica.
 */
export function describeDiagnostic(analysis: ImportAnalysis): string {
  const { diagnostic: d, quality: q } = analysis;
  const money = d.totalBilled.toLocaleString('es-ES', { maximumFractionDigits: 0 });
  const parts = [
    `${d.usableContacts.toLocaleString('es-ES')} clientes con teléfono utilizable`,
    `${d.dormantContacts.toLocaleString('es-ES')} sin servicio en más de ${DORMANT_MONTHS} meses`,
  ];
  if (d.overdueServices > 0) parts.push(`${d.overdueServices.toLocaleString('es-ES')} revisiones vencidas`);
  if (d.totalBilled > 0) parts.push(`${money} € facturados en el histórico`);
  return `${parts.join('. ')}. Calidad de los datos: ${q.score}%.`;
}

// ===========================================================================
// La confirmación — aquí sí se escribe
// ===========================================================================


/**
 * El texto que el cliente tiene que aceptar para poder importar.
 *
 * Versionado por la misma razón que el aviso de la Fase 0: si esto cambia,
 * hay que poder saber cuál firmó cada importación. Se guarda literal en
 * ContactImport.legalDeclaration, no como un booleano.
 *
 * PENDIENTE DE REVISIÓN JURÍDICA, igual que el aviso de oposición. Recoge
 * lo que pide el marco —relación contractual previa y servicios
 * similares— pero quien responde ante la AEPD es el cliente.
 */
export const IMPORT_DECLARATION_V1 =
  'Declaro que las personas de este fichero son clientes con los que mi negocio ha ' +
  'tenido una relación comercial previa, que los datos los recogí yo en el curso de ' +
  'esa relación, y que los mensajes que se les envíen serán sobre servicios similares ' +
  'a los que ya me contrataron.';

export interface CommitImportInput {
  clientId: string;
  tenantId?: string | null;
  /** Fase 3 multi-instancia — la línea a la que pertenece el histórico que se
   *  importa. Su único llamante es POST
   *  /api/admin/portal/recall/[subscriptionId]/import, así que siempre la ha
   *  conocido: hasta ahora la tiraba, y un Job importado sin ella no se puede
   *  atribuir después (el contacto es de la persona, no de la línea). */
  subscriptionId: string;
  csvText: string;
  filename?: string | null;
  mapping?: Partial<Record<ImportField, string>>;
  /** El texto aceptado. Sin esto no se importa. */
  legalDeclaration: string;
  /** Email del operador, o 'client:<clientId>'. */
  declaredBy: string;
  now?: Date;
}

export interface CommitImportResult {
  importId: string;
  contactsCreated: number;
  contactsUpdated: number;
  jobsCreated: number;
  rowsSkipped: number;
  quality: QualityScore;
}

/**
 * Escribe la importación.
 *
 * TRES REGLAS QUE NO SE PUEDEN RELAJAR:
 *
 *   1. SIN DECLARACIÓN NO HAY IMPORTACIÓN. Lanza, y es de las pocas cosas
 *      de este repo que lanzan a propósito: no es un caso degradado que se
 *      pueda seguir a medias, es una precondición. Importar sin ella
 *      dejaría contactos con base legal fabricada por nosotros.
 *
 *   2. LA BASE LEGAL EXISTENTE NUNCA SE PISA. Un contacto que ya la tenía
 *      de una llamada entrante se queda con la suya y con su evidencia —
 *      la primera captura es la que vale, misma regla que recordLegalBasis.
 *
 *   3. UNA FILA SIN TELÉFONO NO SE IMPORTA. No hay clave con la que
 *      deduplicarla ni forma de alcanzarla después. Se cuenta como
 *      saltada, que es información, y no se inventa un contacto.
 */
export async function commitImport(
  prisma: PrismaClient,
  input: CommitImportInput,
): Promise<CommitImportResult> {
  if (!input.legalDeclaration?.trim()) {
    throw new Error('import_requires_legal_declaration');
  }

  const now = input.now ?? new Date();
  const analysis = analyseImport(input.csvText, { mapping: input.mapping, now });

  const record = await prisma.contactImport.create({
    data: {
      clientId: input.clientId,
      tenantId: input.tenantId ?? null,
      filename: input.filename ?? null,
      legalDeclaration: input.legalDeclaration.trim(),
      declaredBy: input.declaredBy,
      qualitySnapshot: analysis.quality as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  let contactsCreated = 0;
  let contactsUpdated = 0;
  let jobsCreated = 0;
  let rowsSkipped = 0;

  for (const row of analysis.rows) {
    if (!row.e164) {
      rowsSkipped += 1;
      continue;
    }

    const existing = await prisma.contact.findUnique({
      where: { clientId_e164: { clientId: input.clientId, e164: row.e164 } },
      select: { id: true, legalBasis: true, name: true, email: true, lastInteractionAt: true },
    });

    const interactionAt = row.lastServiceAt ?? now;
    let contactId: string;

    if (existing) {
      contactId = existing.id;
      await prisma.contact.update({
        where: { id: existing.id },
        data: {
          // Se rellenan los huecos, nunca se pisa lo que ya había: el dato
          // que entró por una conversación real vale más que el de un
          // export, que puede llevar años sin tocarse.
          name: existing.name ?? row.name,
          email: existing.email ?? row.email,
          ...(interactionAt > existing.lastInteractionAt ? { lastInteractionAt: interactionAt } : {}),
          // Regla 2: solo si no tenía ninguna.
          ...(existing.legalBasis === null
            ? {
                legalBasis: 'import_declared',
                legalBasisCapturedAt: now,
                // Apunta al ContactImport, no a un CallEvent. Cuál de los
                // dos se lee en `legalBasis`: 'inbound_contact' apunta a
                // una llamada, 'import_declared' a una importación.
                legalBasisEvidenceId: record.id,
              }
            : {}),
        },
      });
      contactsUpdated += 1;
    } else {
      const created = await prisma.contact.create({
        data: {
          clientId: input.clientId,
          tenantId: input.tenantId ?? null,
          e164: row.e164,
          name: row.name,
          email: row.email,
          source: 'import',
          firstSeenAt: interactionAt,
          lastInteractionAt: interactionAt,
          legalBasis: 'import_declared',
          legalBasisCapturedAt: now,
          legalBasisEvidenceId: record.id,
        },
        select: { id: true },
      });
      contactId = created.id;
      contactsCreated += 1;
    }

    // Un trabajo por fila que traiga fecha. Sin fecha no hay nada que
    // colocar en la línea del tiempo, y un trabajo sin fecha no dispara
    // ni reseña ni revisión — sería una fila muerta.
    if (row.lastServiceAt) {
      // Idempotencia por (contacto, fecha, importe): reimportar el mismo
      // fichero no duplica el histórico.
      //
      // LIMITACIÓN ACEPTADA Y ESCRITA DONDE SE NOTA: dos trabajos reales
      // al mismo cliente, el mismo día y por el mismo importe se colapsan
      // en uno. Es raro, y el fallo contrario —duplicar el histórico
      // entero de un cliente porque subió el fichero dos veces— es común
      // y mucho peor.
      const duplicate = await prisma.job.findFirst({
        where: {
          clientId: input.clientId,
          contactId,
          completedAt: row.lastServiceAt,
          amount: row.amount ?? undefined,
        },
        select: { id: true },
      });

      if (!duplicate) {
        await prisma.job.create({
          data: {
            clientId: input.clientId,
            tenantId: input.tenantId ?? null,
            subscriptionId: input.subscriptionId,
            contactId,
            completedAt: row.lastServiceAt,
            serviceType: row.serviceType,
            amount: row.amount,
            nextServiceDueAt: row.nextServiceAt,
            captureMethod: 'import',
          },
        });
        jobsCreated += 1;
      }
    }
  }

  await prisma.contactImport.update({
    where: { id: record.id },
    data: { contactsCreated, contactsUpdated, jobsCreated, rowsSkipped },
  });

  return {
    importId: record.id,
    contactsCreated,
    contactsUpdated,
    jobsCreated,
    rowsSkipped,
    quality: analysis.quality,
  };
}
