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
  | { ok: true; filesUploaded: number; version: number; url: string | null }
  | { ok: false; error: string };

/** La URL pública de un sitio alojado por nosotros. El dominio propio manda
 *  cuando está configurado; si no, la dirección provisional con su slug, que
 *  es la que permite enseñar la web el mismo día sin esperar a un DNS. */
export function hostedWebsiteUrl(
  site: { slug: string | null; customDomain: string | null },
  portalOrigin: string,
): string | null {
  if (site.customDomain) return `https://${site.customDomain}`;
  return site.slug ? `${portalOrigin.replace(/\/+$/, '')}/sitios/${site.slug}` : null;
}

/** Un slug legible a partir del nombre del negocio. No es SEO: es para que
 *  el operador reconozca la dirección provisional de un vistazo. */
export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

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

/** Tope de la conexión, contado por nosotros y no por ssh2.
 *
 *  `readyTimeout` de ssh2 NO sirve para esto y lo descubrimos probando
 *  contra un servidor real el 24/09/2026: solo empieza a contar cuando el
 *  socket TCP ya está abierto, porque mide el saludo SSH. Si al otro lado no
 *  hay nadie escuchando —un host mal tecleado, un puerto cerrado, un
 *  cortafuegos que descarta el SYN en silencio— el socket se queda
 *  reintentando lo que decida el sistema operativo, que en Linux son más de
 *  dos minutos. La prueba real se colgó 60 segundos enteros con
 *  `readyTimeout: 20000` puesto.
 *
 *  Y el host lo escribe un cliente en un formulario, así que "mal tecleado"
 *  no es el caso raro: es el caso normal. */
export const SFTP_CONNECT_TIMEOUT_MS = 20000;

/** Tope de cada subida. Dos archivos pequeños no tardan esto ni de lejos; el
 *  tope existe para el socket medio muerto, que no da error ni avanza. */
export const SFTP_PUT_TIMEOUT_MS = 60000;

/**
 * Corta una promesa que puede no terminar nunca. Pura y exportada para
 * poder probarla sin red, que es justo lo que no se podía hacer con el
 * timeout que traía ssh2.
 *
 * No cancela nada —no se puede cancelar una promesa— solo deja de
 * esperarla. Quien la use tiene que cerrar el recurso por su cuenta; aquí lo
 * hace el `finally` de uploadFilesOverSftp.
 */
export function withDeadline<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Sube los archivos por SFTP. Separada de publishWebsite para poder probar
 * todo lo demás —construcción, credenciales, auditoría— sin un servidor
 * SFTP delante: esta función es la única que toca la red.
 *
 * Probada contra un servidor real el 24/09/2026 (ver
 * `tests/real/sftp-publish.test.ts`): sube, crea el subdirectorio que no
 * existe y sobreescribe en la segunda publicación. De esa prueba salió el
 * tope de conexión de aquí arriba.
 */
export async function uploadFilesOverSftp(
  credential: { host: string; port: number; username: string; password: string; remotePath: string },
  files: WebsiteFile[],
): Promise<{ ok: true; filesUploaded: number } | { ok: false; error: string }> {
  const { default: SftpClient } = await import('ssh2-sftp-client');
  const client = new SftpClient();
  try {
    await withDeadline(
      client.connect({
        host: credential.host,
        port: credential.port,
        username: credential.username,
        password: credential.password,
        // Se queda puesto: cubre el otro caso, el del servidor que acepta la
        // conexión y luego no saluda.
        readyTimeout: SFTP_CONNECT_TIMEOUT_MS,
      }),
      SFTP_CONNECT_TIMEOUT_MS,
      'sftp_connect_timeout',
    );

    for (const file of files) {
      const remote = `${credential.remotePath}/${file.path}`.replace(/\/{2,}/g, '/');
      const dir = remote.slice(0, remote.lastIndexOf('/'));
      // mkdir recursivo antes de cada archivo: 'assets/' no existe la primera
      // vez y ssh2-sftp-client no lo crea solo.
      if (dir && dir !== credential.remotePath) {
        const exists = await client.exists(dir);
        if (!exists) await client.mkdir(dir, true);
      }
      await withDeadline(client.put(file.content, remote), SFTP_PUT_TIMEOUT_MS, 'sftp_put_timeout');

      // La prueba contra un servidor real dejó los archivos en 666:
      // cualquiera con una cuenta en ese alojamiento compartido podría
      // reescribir el index.html del cliente. Quien manda es el umask de la
      // sesión SFTP, que no controlamos, y el `mode` de `put` no lo pisa
      // (probado: sigue saliendo 666 incluso creando el archivo de cero).
      // Así que se corrige después, con un chmod explícito.
      //
      // Y se ignora si falla: hay alojamientos que no dejan cambiar
      // permisos, y perder una publicación que ya ha subido bien por no
      // poder ajustar un modo sería cambiar un problema pequeño por uno
      // grande.
      await withDeadline(client.chmod(remote, 0o644), SFTP_PUT_TIMEOUT_MS, 'sftp_chmod_timeout').catch(
        () => undefined,
      );
    }

    return { ok: true, filesUploaded: files.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'sftp_error' };
  } finally {
    // end() puede lanzar si la conexión ya murió; que eso no tape el error
    // real de arriba. Y lleva su propio tope: cerrar una conexión que nunca
    // llegó a abrirse es otra forma de colgarse aquí mismo, en el finally,
    // donde ya no hay nada que devuelva el error.
    await withDeadline(client.end(), 5000, 'sftp_end_timeout').catch(() => undefined);
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

  const hosted = website.publishTarget === 'kairikos';
  // La credencial solo hace falta cuando el sitio vive en el servidor del
  // cliente. Con alojamiento propio no hay nada que pedirle.
  if (!hosted && !website.credential) return { ok: false, error: 'credential_missing' };

  const portalOrigin = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.cloud';
  const integrations = await resolveWebsiteIntegrations(prisma, website.clientId, now);

  let files: WebsiteFile[];
  try {
    files = await buildWebsiteFiles({
      integrations,
      formToken: website.formToken,
      // El dominio del portal sale de la variable pública que ya usan los
      // correos: codificarlo aquí dejaría el formulario mudo el día que
      // cambie, y nadie se enteraría hasta que un cliente se quejara.
      portalOrigin,
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

  // DOS DESTINOS, mismo resto. En el del cliente se sube por SFTP; en el
  // nuestro, los archivos se guardan y los sirve /sitios/[slug]. Construir,
  // versionar y auditar es idéntico en los dos, que es justo lo que permite
  // cambiar de alojamiento sin rehacer el producto.
  let uploaded: { ok: true; filesUploaded: number } | { ok: false; error: string };
  if (hosted) {
    uploaded = await storeHostedFiles(prisma, website.id, files, now);
  } else {
    const credential = website.credential;
    if (!credential) return { ok: false, error: 'credential_missing' };
    const password = decryptBuffer(
      {
        ciphertext: credential.passwordCiphertext,
        iv: credential.passwordIv,
        tag: credential.passwordTag,
      },
      encryptionKey(),
    );
    uploaded = await uploadFilesOverSftp(
      {
        host: credential.host,
        port: credential.port,
        username: credential.username,
        password,
        remotePath: credential.remotePath,
      },
      files,
    );
  }

  // La versión se numera SOLO cuando la publicación salió bien: una versión
  // que nunca llegó a verse no sirve para volver atrás, y dejaría huecos en
  // la numeración que el operador tendría que explicarse.
  let version = 0;
  if (uploaded.ok) {
    const last = await prisma.clientWebsiteRelease.findFirst({
      where: { websiteId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    version = (last?.version ?? 0) + 1;
  }

  await prisma.$transaction(async (tx) => {
    await tx.clientWebsite.update({
      where: { id: websiteId },
      data: uploaded.ok
        ? { status: 'published', lastPublishedAt: now, lastPublishError: null }
        : { lastPublishError: uploaded.error.slice(0, 500) },
    });
    if (uploaded.ok) {
      await tx.clientWebsiteRelease.create({
        data: {
          websiteId,
          version,
          // El contenido, no los archivos: el HTML se reconstruye igual desde
          // aquí, y guardar el binario de cada publicación multiplicaría la
          // base de datos por nada.
          copy: website.copy as unknown as object,
          themeKey: website.themeKey,
          publishedAt: now,
          actorType: actor.type,
        },
      });
    }
    await tx.clientWebsiteAudit.create({
      data: {
        websiteId,
        clientId: website.clientId,
        tenantId: website.tenantId,
        action: uploaded.ok ? 'published' : 'publish_failed',
        // Metadatos, nunca la credencial. Host y ruta sí: sirven para saber
        // dónde se publicó sin poder entrar a ningún sitio con ellos.
        after: {
          target: website.publishTarget,
          host: website.credential?.host ?? null,
          remotePath: website.credential?.remotePath ?? null,
          version: uploaded.ok ? version : null,
          files: files.map((f) => f.path),
          error: uploaded.ok ? null : uploaded.error.slice(0, 500),
        },
        actorType: actor.type,
        actorOperatorId: actor.operatorId ?? null,
        actorEmail: actor.email ?? null,
      },
    });
  });

  if (!uploaded.ok) {
    logError('website_publish.upload_failed', new Error(uploaded.error), { websiteId }, 'warn');
    return { ok: false, error: uploaded.error };
  }

  return {
    ok: true,
    filesUploaded: uploaded.filesUploaded,
    version,
    url: hosted ? hostedWebsiteUrl(website, portalOrigin) : null,
  };
}

/**
 * Guarda los archivos del sitio para servirlos desde nuestra infraestructura.
 *
 * Van a la base de datos y no a disco a propósito: el contenedor se recrea en
 * cada despliegue —así que un archivo escrito dentro se pierde— y un volumen
 * más es una cosa más que respaldar y que se puede olvidar. Son dos archivos
 * por sitio, unos 300 KB.
 *
 * Nunca borra antes de escribir, igual que la subida por SFTP: si algo falla
 * a medias, el sitio sigue sirviendo lo anterior en lugar de quedarse vacío.
 */
export async function storeHostedFiles(
  prisma: PrismaClient,
  websiteId: string,
  files: WebsiteFile[],
  now: Date = new Date(),
): Promise<{ ok: true; filesUploaded: number } | { ok: false; error: string }> {
  try {
    for (const file of files) {
      const contentType = file.path.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : file.path.endsWith('.svg')
          ? 'image/svg+xml'
          : file.path.endsWith('.jpg')
            ? 'image/jpeg'
            : 'application/octet-stream';
      await prisma.clientWebsiteFile.upsert({
        where: { websiteId_path: { websiteId, path: file.path } },
        create: { websiteId, path: file.path, contentType, content: file.content, updatedAt: now },
        update: { contentType, content: file.content, updatedAt: now },
      });
    }
    return { ok: true, filesUploaded: files.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'store_error' };
  }
}

/**
 * Vuelve a una versión anterior: restaura su contenido en la fila viva y
 * publica otra vez.
 *
 * No "deshace" nada ni toca versiones antiguas — la vuelta atrás genera una
 * versión NUEVA con el contenido viejo. Así el historial sigue siendo la
 * lista de lo que estuvo publicado y en qué orden, que es lo que hace falta
 * cuando hay que explicar qué pasó.
 */
export async function rollbackWebsite(
  prisma: PrismaClient,
  websiteId: string,
  targetVersion: number,
  actor: { type: 'operator' | 'client' | 'system'; operatorId?: string | null; email?: string | null },
  now: Date = new Date(),
): Promise<PublishResult> {
  const release = await prisma.clientWebsiteRelease.findFirst({
    where: { websiteId, version: targetVersion },
  });
  if (!release) return { ok: false, error: 'release_not_found' };

  await prisma.clientWebsite.update({
    where: { id: websiteId },
    data: { copy: release.copy as unknown as object, themeKey: release.themeKey },
  });
  return publishWebsite(prisma, websiteId, actor, now);
}
