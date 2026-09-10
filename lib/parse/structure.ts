// LLM-backed section structurer.
//
// Used as a fallback when the deterministic regex detector can't find
// enough section headers. The structurer never produces clinical content
// — it only re-segments the (already-normalized) text into named sections.
// Hallucination risk is mitigated by:
//   1. Tool-use structured output (the model can only fill in section keys).
//   2. The provider abstraction below, so any provider must implement the
//      same narrow contract.

import type { ParsedClinicalNote, ParserProvider, SectionKey } from '@/lib/types';
import { anthropicStructurer } from '@/lib/parse/providers/anthropic';
import { mistralStructurer } from '@/lib/parse/providers/mistral';

export interface StructureResult {
  sections: Partial<Record<SectionKey, string>>;
  warnings: string[];
}

export interface Parser {
  name: ParserProvider;
  structure(text: string): Promise<StructureResult>;
}

const NULL_PARSER: Parser = {
  name: 'none',
  async structure() {
    return { sections: {}, warnings: ['LLM structurer disabled'] };
  },
};

export function getParser(): Parser {
  const provider = (process.env.PARSER_PROVIDER ?? 'anthropic').toLowerCase();
  if (provider === 'mistral') {
    if (process.env.MISTRAL_API_KEY) return mistralStructurer;
    // Fall through to anthropic if the flag is set but the key isn't —
    // the deployment hasn't finished BAA review yet.
    return anthropicStructurer;
  }
  if (provider === 'none') return NULL_PARSER;
  return anthropicStructurer;
}

// Apply LLM-derived sections on top of regex-detected sections. Regex
// hits win when both are present, since regex sections are byte-for-byte
// from the source.
export function mergeSections(
  base: ParsedClinicalNote['sections'],
  add: ParsedClinicalNote['sections'],
): ParsedClinicalNote['sections'] {
  const merged: ParsedClinicalNote['sections'] = { ...base };
  for (const [key, value] of Object.entries(add)) {
    if (!merged[key as SectionKey] && value) {
      merged[key as SectionKey] = value;
    }
  }
  return merged;
}
