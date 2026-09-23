import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { encryptBuffer, decryptBuffer, parseHexKey } from './operator-crypto';
import { logError } from './observability';
import { buildWebsiteFiles, type WebsiteFile } from './website-build';
import { resolveWebsiteIntegrations } from './website-integrations';
import type { WebDraftCopy } from './web-draft-ai';

// =============================================================================
// Producto Web, Fase 1 — publicar el sitio de un cliente por SFTP en SU
// alojamiento.
//
// SOLO SFTP. El FTP de toda la vida manda usuario y contraseña en texto plano
// por la red, y lo que se guarda aquí es la llave del sitio de un cliente: la
// misma credencial que permitiría desfigurarle la web. Si un cliente solo
// tiene FTP, la respuesta es que pida SFTP a su alojamiento (lo tienen todos
// los que valen algo) o que lo alojemos nosotros.
//
// La credencial se cifra con SU PROPIA clave
// (WEBSITE_PUBLISH_CREDENTIAL_ENCRYPTION_KEY), como manda el repo: una clase
// de secreto, una clave. Y en la auditoría van host, usuario y
// hasPassword: true — jamás la contraseña ni su ciphertext.
//
// Publicar es idempotente: sube los mismos archivos encima. No borra el
// directorio remoto ANTES de subir, a propósito: si la conexión se corta a
// medio camino, el cliente se queda con su web anterior en vez de con un
// directorio vacío. El coste es que un archivo que dejó de generarse
// sobrevive; hoy solo generamos dos, así que no compensa el riesgo.
// =============================================================================

const ENV_KEY = 'WEBSITE_PUBLISH_CREDENTIAL_ENCRYPTION_KEY';

function encryptionKey(): Buffer {
  return parseHexKey(ENV_KEY, process.env[ENV_KEY]);
}

export interface PublishCredentialInput {
  host: string;
  port?: number;
  username: string;
  password: string;
  remotePath: string;
}

export type PublishResult =
  | { ok: true; filesUploaded: number }
  | { ok: false; error: string };

/** Un host publicable. Mismo criterio que safePublicUrl en la ruta de
 *  sugerencias: el servidor va a conectarse a donde diga esto, y un host
 *  interno convertiría esta función en una puerta a la red privada de la
 *  VPS. No vale localhost, ni IP privada, ni nombre sin punto. */
export function isPublishableHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (!value || !value.includes('.')) return false;
  if (value === 'localhost' || value.endsWith('.local') || value.endsWith('.internal')) return false;
  if (/^127\./.test(value) || /^10\./.test(value) || /^192\.168\./.test(value)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(value)) return false;
  if (value === '169.254.169.254' || value.startsWith('169.254.')) return false;
  if (value === '0.0.0.0' || value === '::1') return false;
  return true;
}

/** Normaliza el directorio remoto: sin barra final, con barra inicial. Un
 *  remotePath vacío publicaría en el directorio de entrada del usuario, que
 *  casi nunca es el de la web. */
export function normalizeRemotePath(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export async function savePublishCredential(
  prisma: PrismaClient,
  websiteId: string,
  input: PublishCredentialInput,
): Promise<{ ok: true } | { ok: false; error: 'invalid_host' }> {
  if (!isPublishableHost(input.host)) return { ok: false, error: 'invalid_host' };

  const { ciphertext, iv, tag } = encryptBuffer(input.password, encryptionKey());
  const data = {
    host: input.host.trim(),
    port: input.port ?? 22,
    username: input.username.trim(),
    remotePath: normalizeRemotePath(input.remotePath),
    passwordCiphertext: ciphertext,
    passwordIv: iv,
    passwordTag: tag,
    savedAt: new Date(),
  };
  await prisma.websitePublishCredential.upsert({
    where: { websiteId },
    create: { websiteId, ...data },
    update: data,
  });
  return { ok: true };
}

/**
 * Sube los archivos por SFTP. Separada de publishWebsite para poder probar
 * todo lo demás —construcción, credenciales, auditoría— sin un servidor
 * SFTP delante: esta función es la única que toca la red.
 *
 * UNVERIFIED AGAINST A REAL HOST: misma advertencia que arrastran
 * google-places.ts y telephony/twilio.ts. La forma sale de la documentación
 * de ssh2-sftp-client, no de una prueba contra un alojamiento real.
 */
export async function uploadFilesOverSftp(
  credential: { host: string; port: number; username: string; password: string; remotePath: string },
  files: WebsiteFile[],
): Promise<PublishResult> {
  const { default: SftpClient } = await import('ssh2-sftp-client');
  const client = new SftpClient();
  try {
    await client.connect({
      host: credential.host,
      port: credential.port,
      username: credential.username,
      password: credential.password,
      // Sin esto, un servidor lento o saturado deja la publicación colgada y
      // con ella la petición del operador.
      readyTimeout: 20000,
    });

    for (const file of files) {
      const remote = `${credential.remotePath}/${file.path}`.replace(/\/{2,}/g, '/');
      const dir = remote.slice(0, remote.lastIndexOf('/'));
      // mkdir recursivo antes de cada archivo: 'assets/' no existe la primera
      // vez y ssh2-sftp-client no lo crea solo.
      if (dir && dir !== credential.remotePath) {
        const exists = await client.exists(dir);
        if (!exists) await client.mkdir(dir, true);
      }
      await client.put(file.content, remote);
    }

    return { ok: true, filesUploaded: files.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'sftp_error' };
  } finally {
    // end() puede lanzar si la conexión ya murió; que eso no tape el error
    // real de arriba.
    await client.end().catch(() => undefined);
  }
}

/**
 * Publica el sitio: genera los archivos, los sube y deja constancia. Nunca
 * lanza — el resultado dice qué pasó, y el error queda también en la fila
 * (lastPublishError) para que el operador lo vea sin bucear en los logs.
 */
export async function publishWebsite(
  prisma: PrismaClient,
  websiteId: string,
  actor: { type: 'operator' | 'client' | 'system'; operatorId?: string | null; email?: string | null },
  now: Date = new Date(),
): Promise<PublishResult> {
  const website = await prisma.clientWebsite.findUnique({
    where: { id: websiteId },
    include: { credential: true },
  });
  if (!website) return { ok: false, error: 'website_not_found' };
  if (!website.credential) return { ok: false, error: 'credential_missing' };

  const integrations = await resolveWebsiteIntegrations(prisma, website.clientId, now);

  let files: WebsiteFile[];
  try {
    files = await buildWebsiteFiles({
      integrations,
      formToken: website.formToken,
      // El dominio del portal sale de la variable pública que ya usan los
      // correos: codificarlo aquí dejaría el formulario mudo el día que
      // cambie, y nadie se enteraría hasta que un cliente se quejara.
      portalOrigin: process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.cloud',
      businessName: website.businessName,
      primaryType: website.primaryType,
      themeKey: website.themeKey,
      phone: website.phone,
      address: website.address,
      city: website.city,
      copy: website.copy as unknown as WebDraftCopy,
      generatedAt: now,
    });
  } catch (err) {
    logError('website_publish.build_failed', err, { websiteId }, 'warn');
    return { ok: false, error: 'build_failed' };
  }

  const password = decryptBuffer(
    {
      ciphertext: website.credential.passwordCiphertext,
      iv: website.credential.passwordIv,
      tag: website.credential.passwordTag,
    },
    encryptionKey(),
  );

  const result = await uploadFilesOverSftp(
    {
      host: website.credential.host,
      port: website.credential.port,
      username: website.credential.username,
      password,
      remotePath: website.credential.remotePath,
    },
    files,
  );

  await prisma.$transaction(async (tx) => {
    await tx.clientWebsite.update({
      where: { id: websiteId },
      data: result.ok
        ? { status: 'published', lastPublishedAt: now, lastPublishError: null }
        : { lastPublishError: result.error.slice(0, 500) },
    });
    await tx.clientWebsiteAudit.create({
      data: {
        websiteId,
        clientId: website.clientId,
        tenantId: website.tenantId,
        action: result.ok ? 'published' : 'publish_failed',
        // Metadatos, nunca la credencial. Host y usuario sí: sirven para
        // saber dónde se publicó sin poder entrar a ningún sitio con ellos.
        after: {
          host: website.credential?.host,
          remotePath: website.credential?.remotePath,
          files: files.map((f) => f.path),
          error: result.ok ? null : result.error.slice(0, 500),
        },
        actorType: actor.type,
        actorOperatorId: actor.operatorId ?? null,
        actorEmail: actor.email ?? null,
      },
    });
  });

  if (!result.ok) {
    logError('website_publish.upload_failed', new Error(result.error), { websiteId }, 'warn');
  }
  return result;
}
