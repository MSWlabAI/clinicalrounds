// ParseStage entry point.
//
// parseClinicalNote is the universal note intake. It is guaranteed to
// return a ParsedClinicalNote — never throws — so the orchestrator can
// always proceed to specialist fan-out. Confidence and warnings tell
// the UI whether to surface a "couldn't fully structure" banner.

import {
  normalizeClinicalText,
} from '@/lib/parse/normalize';
import {
  detectSections,
  renderSectionsBlock,
} from '@/lib/parse/sections';
import {
  getParser,
  mergeSections,
} from '@/lib/parse/structure';
import type {
  ParsedClinicalNote,
  ParserProvider,
  SectionKey,
} from '@/lib/types';

// 200KB ≈ 50k tokens, plenty of headroom for typical pastes while
// keeping the LLM structurer call within Haiku's input window.
const MAX_INPUT_BYTES = 200_000;

export interface ParseOptions {
  // Force-skip the LLM structurer regardless of confidence. Useful in
  // tests and for the deterministic-only rollout phase.
  skipLLM?: boolean;
}

export async function parseClinicalNote(
  raw: string,
  options: ParseOptions = {},
): Promise<ParsedClinicalNote> {
  const start = Date.now();
  const warnings: string[] = [];
  const safeRaw = typeof raw === 'string' ? raw : '';

  let truncated = false;
  let working = safeRaw;
  if (working.length > MAX_INPUT_BYTES) {
    truncated = true;
    working = working.slice(0, MAX_INPUT_BYTES);
    warnings.push(
      `Input truncated to ${MAX_INPUT_BYTES.toLocaleString()} characters ` +
      `(was ${safeRaw.length.toLocaleString()}). Specialists will only see ` +
      `the first portion of the chart.`,
    );
  }

  // 1. Deterministic normalization — always runs, always sync.
  const norm = normalizeClinicalText(working);
  warnings.push(...norm.warnings);

  // 2. Regex section detection on the normalized text.
  const detection = detectSections(norm.normalized);
  let sections: Partial<Record<SectionKey, string>> = detection.sections;
  let confidence = detection.confidence;
  let usedLLM = false;
  let parserProvider: ParserProvider = 'none';

  // 3. Conditional LLM structurer.
  // - high confidence → skip entirely (latency win for clean notes)
  // - medium → run alongside specialists (handled by caller via skipLLM=false)
  // - low → run before specialists, since downstream prompts will be
  //   missing structure otherwise
  if (!options.skipLLM && confidence !== 'high' && norm.normalized.length > 0) {
    const parser = getParser();
    parserProvider = parser.name;
    if (parser.name !== 'none') {
      usedLLM = true;
      const result = await parser.structure(norm.normalized);
      warnings.push(...result.warnings);
      sections = mergeSections(sections, result.sections);

      // Recompute confidence after LLM augmentation.
      const total = Object.keys(sections).length;
      if (total >= 6) confidence = 'high';
      else if (total >= 3) confidence = 'medium';
      else confidence = 'low';
    }
  }

  if (confidence === 'low' && safeRaw.trim().length > 0) {
    warnings.push(
      'Could not fully structure the chart — specialists will analyze ' +
      'normalized free text. Quality may be reduced.',
    );
  }

  return {
    raw: safeRaw,
    normalized: norm.normalized,
    sections,
    warnings,
    confidence,
    cleaningReport: {
      charsStripped: norm.charsStripped,
      quotesFolded: norm.quotesFolded,
      pageBreaksRemoved: norm.pageBreaksRemoved,
      sectionsFound: Object.keys(sections).length,
      usedLLM,
      parserProvider,
      truncated,
      latencyMs: Date.now() - start,
    },
  };
}

export { renderSectionsBlock } from '@/lib/parse/sections';
export { normalizeClinicalText } from '@/lib/parse/normalize';
export { detectSections } from '@/lib/parse/sections';
