import { NextRequest } from 'next/server';
import { parseClinicalNote } from '@/lib/parse';

export const maxDuration = 30;

interface ParseRequestBody {
  rawNotes?: string;
  skipLLM?: boolean;
}

export async function POST(request: NextRequest) {
  let body: ParseRequestBody;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const raw = typeof body.rawNotes === 'string' ? body.rawNotes : '';
  if (!raw.trim()) {
    return new Response(
      JSON.stringify({ error: 'rawNotes is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const parsed = await parseClinicalNote(raw, { skipLLM: !!body.skipLLM });

  return new Response(JSON.stringify(parsed), {
    headers: { 'Content-Type': 'application/json' },
  });
}
