// =============================================================================
// La prueba que faltaba: uploadFilesOverSftp contra un servidor SFTP DE
// VERDAD.
//
// Por qué vive aquí y no en tests/unit: necesita red y un servidor levantado,
// así que no puede correr en CI ni en la suite de siempre. La suite unitaria
// mockea la red, y una suite verde nunca ha dicho nada sobre si esta función
// funciona — es exactamente la trampa nº 5 del CLAUDE.md aplicada a una
// librería en vez de a un despliegue.
//
// Si no hay servidor configurado, se salta sola. Nunca rompe a nadie.
//
// Cómo correrla (un servidor de usar y tirar vale, y es lo que se usó el
// 24/09/2026 para probarla por primera vez):
//
//   docker run -d --name sftp-prueba -p 2222:22 atmoz/sftp:alpine \
//     'webprueba:LACONTRASEÑA:::sitio'
//
//   SFTP_TEST_HOST=... SFTP_TEST_PORT=2222 SFTP_TEST_USER=webprueba \
//   SFTP_TEST_PASS=... SFTP_TEST_PATH=/sitio \
//   npx vitest run --config vitest.real.config.ts
//
// Lo que comprueba, y por qué cada cosa:
//
// 1. Que cree el subdirectorio que aún no existe. Es el punto exacto donde
//    la documentación de ssh2-sftp-client podía estar mintiéndonos: `put`
//    no crea directorios, y nuestro mkdir recursivo va por delante.
// 2. Que publicar dos veces no falle. Publicar es idempotente por diseño y
//    un cliente pulsa el botón más de una vez.
// 3. Que una credencial mala DEVUELVA {ok:false} en vez de lanzar. Todo el
//    producto se apoya en que esta función no rompe la petición del
//    operador.
// 4. Que un puerto muerto no deje la publicación colgada para siempre.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { uploadFilesOverSftp } from '@/lib/website-publish';

const HOST = process.env.SFTP_TEST_HOST;
const USER = process.env.SFTP_TEST_USER;
const PASS = process.env.SFTP_TEST_PASS;
const PORT = Number(process.env.SFTP_TEST_PORT ?? 22);
const PATH = process.env.SFTP_TEST_PATH ?? '/';

const configured = Boolean(HOST && USER && PASS);

describe.skipIf(!configured)('uploadFilesOverSftp contra un servidor real', () => {
  const cred = { host: HOST!, port: PORT, username: USER!, password: PASS!, remotePath: PATH };

  it('sube un archivo en la raíz y otro en un subdirectorio que aún no existe', async () => {
    const result = await uploadFilesOverSftp(cred, [
      { path: 'index.html', content: Buffer.from('<!doctype html><title>Prueba</title><h1>Hola</h1>') },
      { path: 'assets/estilo.css', content: Buffer.from('body{background:#fff}') },
    ]);
    expect(result).toEqual({ ok: true, filesUploaded: 2 });
  }, 60000);

  it('publicar dos veces sobreescribe sin quejarse', async () => {
    const result = await uploadFilesOverSftp(cred, [
      { path: 'index.html', content: Buffer.from('<!doctype html><title>Segunda</title>') },
      { path: 'assets/estilo.css', content: Buffer.from('body{background:#eee}') },
    ]);
    expect(result).toEqual({ ok: true, filesUploaded: 2 });
  }, 60000);

  it('una contraseña mala devuelve {ok:false}, no lanza', async () => {
    const result = await uploadFilesOverSftp({ ...cred, password: 'no-es-la-buena' }, [
      { path: 'index.html', content: Buffer.from('x') },
    ]);
    expect(result.ok).toBe(false);
  }, 60000);

  it('un puerto sin nadie escuchando devuelve {ok:false} y no se cuelga', async () => {
    const result = await uploadFilesOverSftp({ ...cred, port: PORT + 1 }, [
      { path: 'index.html', content: Buffer.from('x') },
    ]);
    expect(result.ok).toBe(false);
  }, 60000);
});
