import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = function () {
    return {
      messages: { create: mockCreate },
    };
  };
  return { default: MockAnthropic };
});

import { parseClinicalNote } from '@/lib/parse';

// Vitest runs from the project root (see vitest.config.ts), so resolving
// against process.cwd() avoids the __dirname / import.meta.url split
// across CJS and ESM builds.
const FIXTURES = resolve(process.cwd(), 'lib', 'parse', '__fixtures__');
function fixture(name: string) {
  return readFileSync(resolve(FIXTURES, name), 'utf-8');
}

describe('parseClinicalNote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.PARSER_PROVIDER;
    delete process.env.MISTRAL_API_KEY;
  });

  it('returns ParsedClinicalNote for empty input without throwing', async () => {
    const result = await parseClinicalNote('');
    expect(result.raw).toBe('');
    expect(result.normalized).toBe('');
    expect(result.confidence).toBe('low');
    expect(result.sections).toEqual({});
  });

  it('coerces non-string input to empty string', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await parseClinicalNote(null as any);
    expect(result.raw).toBe('');
  });

  it('produces high confidence on clean Epic H&P without LLM call', async () => {
    const result = await parseClinicalNote(fixture('clean_epic_hp.txt'));
    expect(result.confidence).toBe('high');
    expect(result.cleaningReport.usedLLM).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.sections.chief_complaint).toBeDefined();
    expect(result.sections.assessment_plan).toBeDefined();
  });

  it('cleans messy paste with page breaks, BOMs, and hyphenated wraps', async () => {
    const result = await parseClinicalNote(fixture('messy_paste_with_artifacts.txt'));
    expect(result.normalized).not.toMatch(/Page \d+ of \d+/);
    expect(result.normalized).not.toMatch(/Printed by/);
    expect(result.normalized).toContain('substernal');
    expect(result.normalized).toContain('sertraline');
    expect(result.cleaningReport.pageBreaksRemoved).toBeGreaterThan(0);
  });

  it('escalates to the LLM structurer on free-text dumps', async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'tool_use',
          name: 'emit_sections',
          input: {
            chief_complaint: 'weakness and confusion',
            hpi: 'Pt is a 72yo M who came in last night feeling weak and confused.',
            pmh: 'T2DM x 20 yrs, CAD with stents in 2019, mild dementia',
            medications:
              'metformin, glipizide, lisinopril, atorvastatin, donepezil',
            vitals: 'BP 96/52, HR 118, T 100.8, sat 94% on RA',
            labs:
              'Glucose 482, AG 22, K 5.4, Cr 2.1 (baseline 1.0), bicarb 12. UA shows ketones large, glucose large.',
            assessment_plan:
              'DKA protocol — IV fluids, insulin gtt, monitor K, ICU admit.',
          },
        },
      ],
    });

    const result = await parseClinicalNote(fixture('free_text_no_headers.txt'));
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.cleaningReport.usedLLM).toBe(true);
    expect(result.cleaningReport.parserProvider).toBe('anthropic');
    expect(Object.keys(result.sections).length).toBeGreaterThanOrEqual(3);
  });

  it('never throws when the LLM provider fails', async () => {
    mockCreate.mockRejectedValue(new Error('upstream 500'));

    const result = await parseClinicalNote(fixture('free_text_no_headers.txt'));
    expect(result.confidence).toBe('low');
    expect(result.warnings.some((w) => /failed/i.test(w))).toBe(true);
    // Specialists still get the normalized text.
    expect(result.normalized.length).toBeGreaterThan(0);
  });

  it('skipLLM=true never calls the structurer, even on free-text', async () => {
    const result = await parseClinicalNote(fixture('free_text_no_headers.txt'), {
      skipLLM: true,
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.cleaningReport.usedLLM).toBe(false);
  });

  it('truncates input above the 200KB cap and emits a warning', async () => {
    const huge = 'A'.repeat(300_000);
    const result = await parseClinicalNote(huge, { skipLLM: true });
    expect(result.cleaningReport.truncated).toBe(true);
    expect(result.warnings.some((w) => /truncated/i.test(w))).toBe(true);
    expect(result.normalized.length).toBeLessThanOrEqual(200_000);
  });

  it('collapses repeated Epic header furniture (snapshot of normalized form)', async () => {
    const result = await parseClinicalNote(fixture('repeated_headers.txt'), {
      skipLLM: true,
    });
    const headerCount = (
      result.normalized.match(/EPIC SHARED MEDICAL RECORD/g) ?? []
    ).length;
    expect(headerCount).toBe(1);
    expect(result.confidence).toBe('high');
  });

  it('parser_smoke fixture survives every nasty character class', async () => {
    const result = await parseClinicalNote(fixture('parser_smoke.txt'), {
      skipLLM: true,
    });
    expect(result.normalized).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    expect(result.normalized).not.toMatch(/[ﬀ-ﬆ]/);
    expect(result.normalized).not.toMatch(/[“”‘’]/);
    expect(result.cleaningReport.quotesFolded).toBeGreaterThan(0);
    expect(result.confidence).toBe('high');
  });

  it('icu progress note still detects assessment_plan section', async () => {
    const result = await parseClinicalNote(fixture('icu_progress_note.txt'), {
      skipLLM: true,
    });
    expect(result.sections.assessment_plan).toBeDefined();
    expect(result.sections.assessment_plan).toContain('Septic shock');
  });

  it('sets parserProvider=none when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await parseClinicalNote(fixture('free_text_no_headers.txt'));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.cleaningReport.parserProvider).toBe('anthropic');
    // usedLLM is true (we tried) but warnings explain why nothing came back
    expect(result.warnings.some((w) => /API_KEY/i.test(w))).toBe(true);
  });
});
