import { z } from 'zod';
import { isIsoDate } from './dates';

// =============================================================================
// Reserva propia para villas — lo que el dueño puede escribir de una villa.
//
// Importes en céntimos e IVA incluido (lo que ve el huésped). Los topes son de
// sentido común para una villa vacacional, no de negocio: frenan un cero de
// más, no un precio caro.
// =============================================================================

const cents = (max: number) => z.number().int().min(0).max(max);

export const VillaFieldsSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(40)
    .optional(),
  maxGuests: z.number().int().min(1).max(40),
  nightlyCents: cents(1_000_000).refine((v) => v >= 1000, 'min_10_eur'),
  minNights: z.number().int().min(1).max(30),
  cleaningFeeCents: cents(200_000).default(0),
  vatRateBps: z.number().int().min(0).max(2100).default(1000),
  touristTaxCents: cents(2_000).default(0),
  sortOrder: z.number().int().min(0).max(100).optional(),
});

export const SeasonSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    startDate: z.string().refine(isIsoDate),
    endDate: z.string().refine(isIsoDate),
    nightlyCents: cents(1_000_000).refine((v) => v >= 1000, 'min_10_eur'),
    minNights: z.number().int().min(1).max(30),
  })
  .refine((s) => s.startDate <= s.endDate, { message: 'end_before_start', path: ['endDate'] });

export const SeasonsSchema = z.array(SeasonSchema).max(40);
