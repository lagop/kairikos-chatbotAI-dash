import { NextResponse, type NextRequest } from 'next/server';
import { spawn } from 'child_process';
import { constantTimeEqual } from '@/lib/operator-crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function parseSummary(stdout: string): { updated: number; created: number; summary: string[] } {
  const lines = stdout.split('\n').filter((l) => l.startsWith('[seed-test-passwords]'));
  const summaryLines: string[] = [];
  let updated = 0;
  let created = 0;

  for (const line of lines) {
    if (line.includes('password refreshed')) updated++;
    if (line.includes('User row created')) created++;
    summaryLines.push(line);
  }

  return { updated, created, summary: summaryLines };
}

async function runSeedScript(): Promise<{ updated: number; created: number; summary: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['tsx', 'scripts/seed-test-passwords.ts'],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        shell: false,
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(parseSummary(stdout));
      } else {
        reject(new Error(`seed script exited with code ${code}: ${stderr || stdout}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

export async function POST(req: NextRequest) {
  // WP-25 — flagged, not fixed: this route spawns a local script gated
  // only by a bearer-style header token, with no environment check at
  // all — a leaked QA_SEED_TOKEN lets anyone shell out on whatever
  // deploy this is reachable from. Didn't add a NODE_ENV/VERCEL_ENV
  // guard here the way WP-00 did for the operator-dev backdoor because,
  // unlike that one, nothing in this repo references this route or
  // QA_SEED_TOKEN (grepped: no docs, no scripts, no CI config) — I can't
  // tell whether an external QA harness depends on it reaching the
  // staging Vercel deploy, and that deploy is itself Vercel-Production-
  // typed (see STAGING.md), so NODE_ENV/VERCEL_ENV can't distinguish
  // "real prod" from "staging" here anyway. Needs a decision from
  // whoever knows if anything external still calls this.
  const token = req.headers.get('x-qa-seed-token');

  if (!token || !process.env.QA_SEED_TOKEN) {
    return NextResponse.json(
      { error: 'missing_or_bad_seed_token' },
      { status: 422 }
    );
  }

  if (!constantTimeEqual(token, process.env.QA_SEED_TOKEN)) {
    return NextResponse.json(
      { error: 'missing_or_bad_seed_token' },
      { status: 422 }
    );
  }

  try {
    const result = await runSeedScript();
    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}

export async function GET() {
  return new NextResponse(null, { status: 405 });
}

export async function PUT() {
  return new NextResponse(null, { status: 405 });
}

export async function PATCH() {
  return new NextResponse(null, { status: 405 });
}

export async function DELETE() {
  return new NextResponse(null, { status: 405 });
}
