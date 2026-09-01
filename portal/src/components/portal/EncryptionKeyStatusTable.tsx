// =============================================================================
// Read-only "is it set" check for every *_ENCRYPTION_KEY this app reads
// from process.env — deliberately NOT editable from here. An encryption
// key that protects secrets stored in Postgres can never live in that
// same Postgres, or the encryption stops protecting anything (anyone
// with DB access would find the key next to the ciphertext it opens).
// Every one of these stays .env-only by design; this panel only saves
// an operator an SSH round-trip to check whether one is missing.
// =============================================================================

const KEYS: { name: string; description: string }[] = [
  { name: 'CHANNEL_CREDENTIAL_ENCRYPTION_KEY', description: 'Tokens de Telegram y Meta por cliente, una vez conectados' },
  { name: 'META_CREDENTIAL_ENCRYPTION_KEY', description: 'App Secret de Meta (Reseñas/Recall/canales)' },
  { name: 'GOOGLE_TOKEN_ENCRYPTION_KEY', description: 'Token de refresco de Google Business (Reseñas)' },
  { name: 'GOOGLE_SEO_TOKEN_ENCRYPTION_KEY', description: 'Token de refresco de Search Console (SEO)' },
  { name: 'GOOGLE_GA4_TOKEN_ENCRYPTION_KEY', description: 'Token de refresco de GA4 (SEO)' },
  { name: 'TWILIO_CREDENTIAL_ENCRYPTION_KEY', description: 'Auth Token de Twilio (recall)' },
  { name: 'STRIPE_CREDENTIAL_ENCRYPTION_KEY', description: 'Clave secreta de Stripe (facturación)' },
  { name: 'INTEGRATION_CREDENTIAL_ENCRYPTION_KEY', description: 'Google Places y los clientes OAuth de Integraciones' },
  { name: 'SEO_CMS_CREDENTIAL_ENCRYPTION_KEY', description: 'Application Password de WordPress (SEO)' },
  { name: 'OPERATOR_TOTP_ENCRYPTION_KEY', description: 'Secretos TOTP de los operadores' },
];

export function EncryptionKeyStatusTable() {
  return (
    <section className="card space-y-4" aria-label="Claves de cifrado">
      <div>
        <h2 className="text-lg font-semibold">Claves de cifrado</h2>
        <p className="mt-1 text-sm text-kairikos-muted">
          Solo lectura — cada clave protege secretos en Postgres, así que vive únicamente en el <code>.env</code> del VPS,
          nunca en la base de datos. Genera una que falte con <code>openssl rand -hex 32</code> y reinicia el stack.
        </p>
      </div>
      <ul className="divide-y divide-kairikos-border">
        {KEYS.map((key) => {
          const configured = Boolean(process.env[key.name]);
          return (
            <li key={key.name} className="flex items-center justify-between gap-4 py-2.5" data-testid={`encryption-key-${key.name}`}>
              <div className="min-w-0">
                <p className="font-mono text-sm">{key.name}</p>
                <p className="text-xs text-kairikos-muted">{key.description}</p>
              </div>
              <span
                className={`shrink-0 text-sm font-medium ${configured ? 'text-kairikos-success' : 'text-kairikos-danger'}`}
                data-testid={`encryption-key-${key.name}-status`}
              >
                {configured ? 'Configurada' : 'Falta'}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
