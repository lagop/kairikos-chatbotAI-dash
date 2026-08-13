'use client';

// =============================================================================
// WP-28 — compact controls for "choose a few of a short list" (ChipToggleGroup)
// and "choose one of a short list" (CompactRadioGroup).
//
// Before this, every wizard step that needed either pattern reached for
// CheckboxGroup / RadioGroup (portal/wizard-steps/primitives.tsx), which
// render one full-width row per option — correct for a long or
// unfamiliar list, but a step like "Horario" (7 mutually-compatible days)
// or "Fuera de horario" (3 mutually-exclusive options) burns a whole
// screen of vertical scroll on a decision that fits in one row of chips.
//
// This is that other layout for the same two contracts. Same props as
// CheckboxGroup / RadioGroup (legend/name/options/value(s)/onChange/error)
// so a step can swap the import without touching how it reads or emits
// its own payload — see Step5Horario.tsx for the pilot. Fase 3's new
// catalogs (SEO, Captación, Reseñas) have the same "days / channels /
// sources / time slots" shape repeatedly; import from here instead of
// re-deriving a third rendering of the same two contracts.
//
// Accessibility: both render real <input type="checkbox|radio"> elements
// (just visually restyled as pills), so Tab/Space/Arrow-key behavior and
// screen-reader semantics are the browser's native implementation, not
// something hand-rolled here. The whole pill is the click/tap target
// (the input sits inside the <label>), and the selected state is shown
// on the pill itself (border + background), not just the tiny native
// control, so the affordance reads at a glance and at a distance.
// =============================================================================

export interface CompactOption {
  value: string;
  label: string;
}

function pillClass(checked: boolean): string {
  return [
    'inline-flex cursor-pointer select-none items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition',
    checked
      ? 'border-kairikos-accent bg-kairikos-accent/15 text-kairikos-text'
      : 'border-kairikos-border bg-kairikos-surface2 text-kairikos-muted hover:text-kairikos-text',
  ].join(' ');
}

export function ChipToggleGroup({
  legend,
  name,
  options,
  values,
  onChange,
  error,
}: {
  legend: string;
  name: string;
  options: CompactOption[];
  values: string[];
  onChange: (v: string[]) => void;
  error?: string;
}) {
  const toggle = (v: string, checked: boolean) => {
    if (checked) {
      onChange([...new Set([...values, v])]);
    } else {
      onChange(values.filter((x) => x !== v));
    }
  };
  return (
    <fieldset>
      <legend className="mb-1.5 block text-sm font-medium text-kairikos-text">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const id = `${name}-${o.value}`;
          const checked = values.includes(o.value);
          return (
            <label key={o.value} htmlFor={id} className={pillClass(checked)}>
              <input
                id={id}
                name={name}
                type="checkbox"
                value={o.value}
                checked={checked}
                onChange={(e) => toggle(o.value, e.target.checked)}
                className="h-3.5 w-3.5 rounded border-kairikos-border bg-kairikos-surface2 text-kairikos-accent focus:ring-kairikos-accent"
              />
              {o.label}
            </label>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-kairikos-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function CompactRadioGroup({
  legend,
  name,
  options,
  value,
  onChange,
  error,
}: {
  legend: string;
  name: string;
  options: CompactOption[];
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 block text-sm font-medium text-kairikos-text">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const id = `${name}-${o.value}`;
          const checked = value === o.value;
          return (
            <label key={o.value} htmlFor={id} className={pillClass(checked)}>
              <input
                id={id}
                name={name}
                type="radio"
                value={o.value}
                checked={checked}
                onChange={() => onChange(o.value)}
                className="h-3.5 w-3.5 border-kairikos-border bg-kairikos-surface2 text-kairikos-accent focus:ring-kairikos-accent"
              />
              {o.label}
            </label>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-kairikos-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
