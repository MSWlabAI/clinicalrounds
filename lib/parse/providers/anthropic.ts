// Anthropic-backed section structurer using Claude Haiku 4.5.
//
// We use tool-use structured output so the model can only emit section
// keys — never free-form clinical content. This is the default provider
// for the ParseStage LLM fallback.

import Anthropic from '@anthropic-ai/sdk';
import type { Parser, StructureResult } from '@/lib/parse/structure';
import type { SectionKey } from '@/lib/types';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const STRUCTURE_TOOL = {
  name: 'emit_sections',
  description:
    'Emit the input clinical note re-organized into canonical sections. ' +
    'You must NOT invent, summarize, paraphrase, or add any clinical content. ' +
    'Each section value must be a verbatim substring (or concatenation of substrings) ' +
    'from the input text. If a section is not present in the input, omit it.',
  input_schema: {
    type: 'object',
    properties: {
      chief_complaint: { type: 'string' },
      hpi: { type: 'string' },
      pmh: { type: 'string' },
      psh: { type: 'string' },
      medications: { type: 'string' },
      allergies: { type: 'string' },
      social_history: { type: 'string' },
      family_history: { type: 'string' },
      vitals: { type: 'string' },
      physical_exam: { type: 'string' },
      labs: { type: 'string' },
      imaging: { type: 'string' },
      assessment_plan: { type: 'string' },
      other: { type: 'string' },
    },
    additionalProperties: false,
  },
} as const;

const SYSTEM_PROMPT = `You are a clinical note re-segmenter. Your only job is to take a clinical note that may be unstructured, oddly formatted, or copy-pasted from an EHR, and return the SAME text re-organized into canonical sections via the emit_sections tool.

Hard rules:
- Never invent, summarize, or paraphrase clinical content. Each section value must be a verbatim substring of the input.
- If you cannot confidently assign a piece of text to a canonical section, place it in the "other" section.
- Omit sections that are not present in the input. Do not produce empty strings.
- Do not add headings, bullets, or commentary that wasn't already in the source.
- You will be re-run if you produce content not present in the source. Faithfulness > coverage.`;

const SECTION_KEYS: SectionKey[] = [
  'chief_complaint', 'hpi', 'pmh', 'psh', 'medications', 'allergies',
  'social_history', 'family_history', 'vitals', 'physical_exam', 'labs',
  'imaging', 'assessment_plan', 'other',
];

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

export const anthropicStructurer: Parser = {
  name: 'anthropic',
  async structure(text: string): Promise<StructureResult> {
    const warnings: string[] = [];
    if (!process.env.ANTHROPIC_API_KEY) {
      warnings.push('ANTHROPIC_API_KEY not set — skipping LLM structuring');
      return { sections: {}, warnings };
    }
    if (!text || text.trim().length === 0) {
      return { sections: {}, warnings };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response: any = await client().messages.create({
        model: HAIKU_MODEL,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: [STRUCTURE_TOOL as any],
        tool_choice: { type: 'tool', name: 'emit_sections' },
        messages: [
          {
            role: 'user',
            content:
              'Re-segment this clinical note. Use the emit_sections tool. ' +
              'Verbatim substrings only.\n\n---\n' + text,
          },
        ],
      });

      const sections: Partial<Record<SectionKey, string>> = {};
      for (const block of response.content ?? []) {
        if (block?.type === 'tool_use' && block?.name === 'emit_sections') {
          const input = (block.input ?? {}) as Record<string, unknown>;
          for (const key of SECTION_KEYS) {
            const value = input[key];
            if (typeof value === 'string' && value.trim().length > 0) {
              sections[key] = value;
            }
          }
        }
      }

      if (Object.keys(sections).length === 0) {
        warnings.push('LLM structurer returned no sections');
      }

      return { sections, warnings };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`LLM structurer failed: ${msg}`);
      return { sections: {}, warnings };
    }
  },
};
