import { NextResponse, type NextRequest } from 'next/server';
import { spawn } from 'child_process';
import { createHash, timingSafeEqual } from 'crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

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
  const token = req.headers.get('x-qa-seed-token');

  if (!token || !process.env.QA_SEED_TOKEN) {
    return NextResponse.json(
      { error: 'missing_or_bad_seed_token' },
      { status: 422 }
    );
  }

  if (!constantTimeCompare(token, process.env.QA_SEED_TOKEN)) {
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
