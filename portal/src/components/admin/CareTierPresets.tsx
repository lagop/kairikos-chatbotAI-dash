"use client";

import { CARE_TIERS } from "@/lib/custom-care-rules";

// =============================================================================
// 20/11/2026 — los tres niveles de mantenimiento como atajos: rellenan la cuota
// y los meses sin cobrar del formulario donde se usan (oferta a medida y
// presupuesto de web). No guardan nada por sí solos.
// =============================================================================

export function CareTierPresets({
  onPick,
  testIdPrefix,
}: {
  onPick: (euros: string, includedMonths: number) => void;
  testIdPrefix: string;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Niveles de mantenimiento"
    >
      <span className="text-xs text-kairikos-muted">Niveles:</span>
      {CARE_TIERS.map((tier) => (
        <button
          key={tier.key}
          type="button"
          className="btn-ghost px-2 py-1 text-xs"
          title={`${tier.hint}${tier.includedMonths ? ` ${tier.includedMonths} meses incluidos.` : ""}`}
          onClick={() =>
            onPick((tier.monthlyCents / 100).toFixed(2), tier.includedMonths)
          }
          data-testid={`${testIdPrefix}-tier-${tier.key}`}
        >
          {tier.label} · {tier.monthlyCents / 100} €
        </button>
      ))}
    </div>
  );
}
