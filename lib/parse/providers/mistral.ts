// Mistral-backed section structurer.
//
// OFF by default. The provider is wired through PARSER_PROVIDER=mistral
// only after BAA / legal review of Mistral's data handling. Until then
// we keep the implementation behind a runtime check on MISTRAL_API_KEY
// so accidentally setting the flag without the key falls through to the
// Anthropic default rather than sending PHI off-platform.

import type { Parser, StructureResult } from '@/lib/parse/structure';
import type { SectionKey } from '@/lib/types';

const SECTION_KEYS: SectionKey[] = [
  'chief_complaint', 'hpi', 'pmh', 'psh', 'medications', 'allergies',
  'social_history', 'family_history', 'vitals', 'physical_exam', 'labs',
  'imaging', 'assessment_plan', 'other',
];

const SYSTEM_PROMPT =
  'You are a clinical note re-segmenter. Return ONLY a JSON object whose ' +
  'keys are a subset of: ' + SECTION_KEYS.join(', ') + '. Each value must ' +
  'be a verbatim substring of the input — never paraphrase, summarize, or ' +
  'invent content. Omit sections not present in the input.';

export const mistralStructurer: Parser = {
  name: 'mistral',
  async structure(text: string): Promise<StructureResult> {
    const warnings: string[] = [];
    const apiKey = process.env.MISTRAL_API_KEY;
    if (!apiKey) {
      warnings.push('MISTRAL_API_KEY not set — Mistral provider disabled');
      return { sections: {}, warnings };
    }
    if (!text || text.trim().length === 0) {
      return { sections: {}, warnings };
    }

    const model = process.env.MISTRAL_MODEL ?? 'mistral-small-latest';
    const endpoint =
      process.env.MISTRAL_ENDPOINT ?? 'https://api.mistral.ai/v1/chat/completions';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content:
                'Re-segment this clinical note into a JSON object of canonical sections. ' +
                'Verbatim substrings only.\n\n---\n' + text,
            },
          ],
        }),
      });

      if (!res.ok) {
        warnings.push(`Mistral structurer HTTP ${res.status}`);
        return { sections: {}, warnings };
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      const sections = parseSectionJSON(content);
      if (Object.keys(sections).length === 0) {
        warnings.push('Mistral structurer returned no sections');
      }
      return { sections, warnings };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Mistral structurer failed: ${msg}`);
      return { sections: {}, warnings };
    }
  },
};

function parseSectionJSON(text: string): Partial<Record<SectionKey, string>> {
  const sections: Partial<Record<SectionKey, string>> = {};
  if (!text) return sections;

  // Permissive JSON extraction — Mistral occasionally wraps output in
  // ```json fences. Strip those before parsing.
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return sections;
  }
  if (!parsed || typeof parsed !== 'object') return sections;

  const obj = parsed as Record<string, unknown>;
  for (const key of SECTION_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      sections[key] = value;
    }
  }
  return sections;
}
