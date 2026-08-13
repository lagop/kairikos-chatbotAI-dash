import 'server-only';
import { logError } from './observability';

// =============================================================================
// KAIA-2913 — Google Drive folder provisioning for new client onboarding.
//
// Creates the per-client folder `Clientes/<NombreNegocio>/` under the
// configured parent (DRIVE_PARENT_FOLDER_ID) and uploads the kit
// artifacts `00_Intake.json` + `01_Kit_de_Onboarding.pdf` so the operator
// has the full client context in one place from Day 1.
//
// Auth: OAuth refresh-token flow. The refresh token lives in Secret
// Manager (per KAIA-1702 guardrail — NEVER in adapterConfig.env). The
// access token is fetched at call time and cached for `expires_in`
// seconds.
//
// Configuration (env vars; all server-side only):
//   GOOGLE_OAUTH_REFRESH_TOKEN  — long-lived refresh token (REQUIRED)
//   GOOGLE_OAUTH_CLIENT_ID      — OAuth client id (REQUIRED)
//   GOOGLE_OAUTH_CLIENT_SECRET  — OAuth client secret (REQUIRED)
//   DRIVE_PARENT_FOLDER_ID      — parent folder under which `Clientes/`
//                                 lives (REQUIRED for live folders).
//                                 In dev we fall back to creating a folder
//                                 in the OAuth user's My Drive root.
//   KAIRIKOS_KIT_INTAKE_PDF_URL — public URL for the onboarding kit PDF
//                                 (used to seed `01_Kit_de_Onboarding.pdf`).
//                                 Optional in dev; absence is logged but
//                                 doesn't fail the intake.
//
// Failure mode: any env-var absence returns `{ ok: false, ... }` instead
// of throwing — the caller (the intake route) treats it as a soft failure
// and still completes the DB write + operator notification. The operator
// can then trigger a manual retry. This is intentional: a Drive outage
// must NOT block intake.
// =============================================================================

export interface DriveFolderResult {
  ok: boolean;
  folderId?: string;
  folderUrl?: string;
  uploadedFiles?: { name: string; id: string; webViewLink?: string }[];
  error?: string;
  skipped?: 'not_configured' | 'auth_failed' | 'api_error';
}

interface DriveEnvSnapshot {
  refreshToken: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  parentFolderId: string | undefined;
  kitPdfUrl: string | undefined;
}

function readEnv(): DriveEnvSnapshot {
  return {
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    parentFolderId: process.env.DRIVE_PARENT_FOLDER_ID,
    kitPdfUrl: process.env.KAIRIKOS_KIT_INTAKE_PDF_URL,
  };
}

interface CachedAccessToken {
  token: string;
  expiresAtMs: number;
}

let cachedToken: CachedAccessToken | null = null;

async function fetchAccessToken(env: DriveEnvSnapshot): Promise<string | null> {
  if (
    cachedToken &&
    cachedToken.expiresAtMs - Date.now() > 60_000 // 60s skew
  ) {
    return cachedToken.token;
  }

  if (!env.refreshToken || !env.clientId || !env.clientSecret) {
    return null;
  }

  const body = new URLSearchParams({
    client_id: env.clientId,
    client_secret: env.clientSecret,
    refresh_token: env.refreshToken,
    grant_type: 'refresh_token',
  });

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) return null;
    cachedToken = {
      token: json.access_token,
      expiresAtMs: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return cachedToken.token;
  } catch (err) {
    logError('google_drive.fetch_access_token', err, { route: 'lib/google-drive.ts' }, 'warn');
    return null;
  }
}

function sanitizeFolderName(name: string): string {
  // Drive folder names forbid '/', ':', and a few control chars. We keep
  // a permissive replacement so the operator sees a readable name.
  return name
    .replace(/[\/\\:?*"<>|\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Cliente';
}

export interface CreateClientFolderInput {
  businessName: string;
  intakePayload: unknown;
}

export async function createClientFolderAndUploadKit(
  input: CreateClientFolderInput,
): Promise<DriveFolderResult> {
  const env = readEnv();

  if (!env.refreshToken || !env.clientId || !env.clientSecret) {
    return {
      ok: false,
      skipped: 'not_configured',
      error:
        'GOOGLE_OAUTH_REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET not set; skipping Drive provisioning',
    };
  }

  const accessToken = await fetchAccessToken(env);
  if (!accessToken) {
    return {
      ok: false,
      skipped: 'auth_failed',
      error: 'Failed to mint Google OAuth access token',
    };
  }

  const folderName = sanitizeFolderName(
    `${input.businessName} — ${new Date().toISOString().slice(0, 10)}`,
  );

  // 1. Create the folder. We always create a fresh folder per submission —
  // operator renames / merges on T+0 if the same client comes back.
  const folderRes = await fetch(
    'https://www.googleapis.com/drive/v3/files?fields=id,webViewLink,name',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: env.parentFolderId ? [env.parentFolderId] : undefined,
      }),
    },
  );

  if (!folderRes.ok) {
    return {
      ok: false,
      skipped: 'api_error',
      error: `Drive folder create failed: ${folderRes.status} ${await safeText(folderRes)}`,
    };
  }

  const folder = (await folderRes.json()) as {
    id?: string;
    webViewLink?: string;
    name?: string;
  };
  if (!folder.id) {
    return {
      ok: false,
      skipped: 'api_error',
      error: 'Drive folder create returned no id',
    };
  }

  const uploaded: { name: string; id: string; webViewLink?: string }[] = [];

  // 2. Upload 00_Intake.json with the full payload.
  const intakeUpload = await uploadFile({
    accessToken,
    parentId: folder.id,
    name: '00_Intake.json',
    mimeType: 'application/json',
    body: JSON.stringify(input.intakePayload, null, 2),
  });
  if (intakeUpload) uploaded.push(intakeUpload);

  // 3. Optionally upload 01_Kit_de_Onboarding.pdf from the public URL.
  if (env.kitPdfUrl) {
    try {
      const pdfRes = await fetch(env.kitPdfUrl);
      if (pdfRes.ok) {
        const buf = Buffer.from(await pdfRes.arrayBuffer());
        const kitUpload = await uploadFile({
          accessToken,
          parentId: folder.id,
          name: '01_Kit_de_Onboarding.pdf',
          mimeType: 'application/pdf',
          body: buf,
        });
        if (kitUpload) uploaded.push(kitUpload);
      }
    } catch (err) {
      // Soft-fail: the folder + intake JSON already succeeded, so this
      // doesn't flip the function's own ok/skipped result — but the
      // comment here used to claim "log only" without an actual log
      // call, so a kit-PDF failure was invisible everywhere.
      logError(
        'google_drive.kit_pdf_upload',
        err,
        { route: 'lib/google-drive.ts', driveFolderId: folder.id, businessName: input.businessName },
        'warn',
      );
    }
  }

  return {
    ok: true,
    folderId: folder.id,
    folderUrl: folder.webViewLink,
    uploadedFiles: uploaded,
  };
}

interface UploadArgs {
  accessToken: string;
  parentId: string;
  name: string;
  mimeType: string;
  body: string | Buffer;
}

async function uploadFile(args: UploadArgs): Promise<
  { name: string; id: string; webViewLink?: string } | null
> {
  // Use the multipart upload endpoint so we can attach JSON / PDF bodies.
  const boundary = `kairikos-${Math.random().toString(36).slice(2)}`;
  const metadata = JSON.stringify({
    name: args.name,
    parents: [args.parentId],
  });

  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
  const sep = `\r\n--${boundary}\r\nContent-Type: ${args.mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;

  const headBuf = Buffer.from(head, 'utf8');
  const sepBuf = Buffer.from(sep, 'utf8');
  const tailBuf = Buffer.from(tail, 'utf8');
  const bodyBuf =
    typeof args.body === 'string' ? Buffer.from(args.body, 'utf8') : args.body;
  const payload = Buffer.concat([headBuf, sepBuf, bodyBuf, tailBuf]);

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,name',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body: payload,
    },
  );

  if (!res.ok) return null;
  const json = (await res.json()) as {
    id?: string;
    webViewLink?: string;
    name?: string;
  };
  if (!json.id) return null;
  return {
    name: json.name ?? args.name,
    id: json.id,
    webViewLink: json.webViewLink,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return '';
  }
}