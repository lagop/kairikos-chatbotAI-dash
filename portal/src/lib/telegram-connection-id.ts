import { z } from 'zod';

// =============================================================================
// El connectionId que n8n reenvía a /api/internal/channels/telegram/* sale
// de la query string del webhook — es decir, de una URL que cualquiera puede
// llamar con lo que quiera.
//
// TelegramConnection.id es `@db.Uuid`: pasarle a Prisma una cadena que no es
// un UUID no da "no encontrado", revienta con
// `Inconsistent column data: Error creating UUID` y la ruta devuelve un 500.
// Se vio el 22/09/2026 al probar desde n8n, recién puesta PORTAL_API_KEY.
// Validar el formato antes convierte eso en un 400 limpio, sin pasar por la
// base de datos ni ensuciar los logs de error.
// =============================================================================

export const telegramConnectionIdSchema = z.string().trim().uuid();
