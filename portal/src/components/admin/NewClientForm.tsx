'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Alta manual de cliente — POST /api/admin/portal/clients.
//
// Cada línea de producto elige entre 'active' (el operador ya cobró por
// otra vía y lo marca activo de inmediato) o 'checkout_link' (se manda
// un enlace de pago de Stripe por correo, igual que el autoservicio).
// Mismo patrón de fetch + toast que ProductAssignment.tsx.
// =============================================================================

export interface CreatableProduct {
  id: string;
  code: string;
  tier: string;
  name: string;
  priceCents: number;
  currency: string;
}

interface ProductLine {
  key: number;
  productId: string;
  mode: 'active' | 'checkout_link';
}

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
}

let nextLineKey = 1;

export function NewClientForm({ products }: { products: CreatableProduct[] }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [lines, setLines] = useState<ProductLine[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addLine() {
    setLines((prev) => [...prev, { key: nextLineKey++, productId: products[0]?.id ?? '', mode: 'checkout_link' }]);
  }

  function updateLine(key: number, patch: Partial<ProductLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: number) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!email || !email.includes('@')) {
      setError('Introduce un email válido.');
      return;
    }
    if (!name.trim() || !companyName.trim()) {
      setError('El nombre de contacto y el de la empresa son obligatorios.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/portal/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          name,
          companyName,
          products: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, mode: l.mode })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 409) {
          setError('Ya existe un cliente con ese email.');
        } else {
          setError('No se ha podido crear el cliente. Inténtalo de nuevo.');
        }
        return;
      }
      router.push(`/admin/portal/${data.clientId}`);
      router.refresh();
    } catch {
      setError('Error de conexión. Inténtalo de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card flex flex-col gap-5" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="new-client-email" className="label">
            Email de contacto
          </label>
          <input
            id="new-client-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="dueño@negocio.es"
            className="input"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="new-client-name" className="label">
            Nombre de contacto
          </label>
          <input
            id="new-client-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="María García"
            className="input"
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <label htmlFor="new-client-company" className="label">
            Nombre del negocio
          </label>
          <input
            id="new-client-company"
            type="text"
            required
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Peluquería Aurora"
            className="input"
          />
        </div>
      </div>

      <div className="space-y-3 border-t border-kairikos-border pt-4">
        <div className="flex items-center justify-between">
          <p className="label">Productos (opcional — se pueden asignar después)</p>
          <button type="button" className="btn-ghost" onClick={addLine} disabled={products.length === 0}>
            + Añadir producto
          </button>
        </div>

        {lines.length === 0 ? (
          <p className="text-sm text-kairikos-muted">Sin productos por ahora — la ficha se crea vacía.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lines.map((line) => (
              <li key={line.key} className="flex flex-wrap items-center gap-2 rounded-xl border border-kairikos-border bg-kairikos-surface2 px-3 py-2">
                <select
                  className="input flex-1 min-w-[200px]"
                  value={line.productId}
                  onChange={(e) => updateLine(line.key, { productId: e.target.value })}
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.tier}) · {formatPrice(p.priceCents, p.currency)}/mes
                    </option>
                  ))}
                </select>
                <select
                  className="input w-auto"
                  value={line.mode}
                  onChange={(e) => updateLine(line.key, { mode: e.target.value as ProductLine['mode'] })}
                >
                  <option value="checkout_link">Enviar enlace de pago</option>
                  <option value="active">Activo ahora (ya pagado)</option>
                </select>
                <button type="button" className="btn-ghost" onClick={() => removeLine(line.key)}>
                  Quitar
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-kairikos-danger">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button type="submit" className="btn-primary" disabled={submitting}>
          {submitting ? 'Creando…' : 'Crear cliente'}
        </button>
      </div>
    </form>
  );
}
