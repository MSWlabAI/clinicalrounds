// Deterministic, synchronous text cleaner for raw Epic copy-paste.
//
// Goal: produce a UTF-8 normalized, control-character-free, dehyphenated
// string that downstream regex section detection and LLM structuring can
// both rely on. Never throws. Reports counts back so the UI can show what
// was changed.
//
// This module intentionally has no external dependencies and is safe to
// import from server, client, and CLI contexts.

export interface NormalizeResult {
  normalized: string;
  charsStripped: number;
  quotesFolded: number;
  pageBreaksRemoved: number;
  warnings: string[];
}

const SMART_QUOTE_MAP: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '′': "'", '″': '"',
};

const DASH_MAP: Record<string, string> = {
  '‐': '-', '‑': '-', '‒': '-', '–': '-',
  '—': '--', '―': '--', '−': '-',
};

const LIGATURE_MAP: Record<string, string> = {
  'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl',
  'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'ft', 'ﬆ': 'st',
};

// Epic and other EHR systems often emit page-break sentinels when notes
// are exported / cut-and-pasted from print previews. These strings repeat
// across pages and never carry clinical content.
const PAGE_BREAK_PATTERNS: RegExp[] = [
  /^\s*Page\s+\d+\s+of\s+\d+\s*$/gim,
  /^\s*-\s*Page\s+\d+\s*-\s*$/gim,
  /^\s*\[?\s*Continued on next page\s*\]?\s*$/gim,
  /^\s*-{3,}\s*Page\s+Break\s*-{3,}\s*$/gim,
  /^\s*\f\s*$/gm,
];

// Lines that look like printer/footer junk: a date stamp followed by a
// patient identifier, repeated on every page. We don't try to be perfect —
// just collapse the obvious cases.
const PRINTER_FOOTER_PATTERN =
  /^(?:Printed (?:by|on)|Generated (?:by|on)|MRN:|Encounter #|Patient ID:)\s.*$/gim;

export function normalizeClinicalText(input: string): NormalizeResult {
  const warnings: string[] = [];
  if (!input) {
    return {
      normalized: '',
      charsStripped: 0,
      quotesFolded: 0,
      pageBreaksRemoved: 0,
      warnings,
    };
  }

  let text = input;
  const originalLength = text.length;

  // 1. Unicode NFKC: fold compatibility forms, full-width digits, etc.
  // Wrapped in try/catch since some runtimes ship without ICU data — fall
  // back to the raw string instead of throwing the whole pipeline.
  try {
    text = text.normalize('NFKC');
  } catch {
    warnings.push('Unicode NFKC normalization unavailable in this runtime');
  }

  // 2. Strip BOMs and zero-width spaces. Epic exports often carry these
  // when notes were authored in Word and pasted through.
  text = text.replace(/[﻿​‌‍⁠￾]/g, '');

  // 3. Replace form feeds with newlines (page breaks become whitespace).
  let pageBreaksRemoved = 0;
  text = text.replace(/\f/g, () => {
    pageBreaksRemoved++;
    return '\n';
  });

  // 4. Strip C0 / C1 control characters except \n (LF) and \t (TAB).
  // \r is normalized to \n later.
  const beforeControlStrip = text.length;
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  const charsStrippedControl = beforeControlStrip - text.length;

  // 5. Fold smart quotes, dashes, ligatures.
  let quotesFolded = 0;
  text = text.replace(/[‘’‚‛“”„‟′″]/g, (ch) => {
    quotesFolded++;
    return SMART_QUOTE_MAP[ch] ?? ch;
  });
  text = text.replace(/[‐-―−]/g, (ch) => DASH_MAP[ch] ?? ch);
  text = text.replace(/[ﬀ-ﬆ]/g, (ch) => LIGATURE_MAP[ch] ?? ch);

  // 6. Collapse non-breaking spaces and other unicode spaces to ASCII space.
  text = text.replace(/[  -   　]/g, ' ');

  // 7. Remove Epic page-break sentinels and common print footers.
  for (const pattern of PAGE_BREAK_PATTERNS) {
    text = text.replace(pattern, () => {
      pageBreaksRemoved++;
      return '';
    });
  }
  text = text.replace(PRINTER_FOOTER_PATTERN, '');

  // 8. Remove repeated identical headers/footers — lines that appear
  // 3+ times verbatim are almost always page furniture, not content.
  // We keep the first occurrence so the document still reads correctly.
  const lineCounts = new Map<string, number>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length >= 8 && trimmed.length <= 120) {
      lineCounts.set(trimmed, (lineCounts.get(trimmed) ?? 0) + 1);
    }
  }
  const repeated = new Set<string>();
  for (const [line, count] of lineCounts) {
    if (count >= 3) repeated.add(line);
  }
  if (repeated.size > 0) {
    const seen = new Set<string>();
    text = text
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!repeated.has(trimmed)) return true;
        if (seen.has(trimmed)) return false;
        seen.add(trimmed);
        return true;
      })
      .join('\n');
  }

  // 9. Dehyphenate line-wrapped words: "hyper-\nkalemia" → "hyperkalemia".
  // Only collapse when the next character is lowercase, to preserve
  // intentional hyphens (e.g. "post-op" wrapping mid-line is rare).
  text = text.replace(/(\w)-\n(?=[a-z])/g, '$1');

  // 10. Collapse runs of internal whitespace (>10 spaces) and >3 blank lines.
  text = text.replace(/[ \t]{10,}/g, '  ');
  text = text.replace(/\n{4,}/g, '\n\n\n');

  // 11. Trim trailing whitespace on each line.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();

  const charsStripped = originalLength - text.length;

  if (charsStripped > 0 && originalLength > 0) {
    const pct = Math.round((charsStripped / originalLength) * 100);
    if (pct >= 25) {
      warnings.push(
        `Normalization removed ${pct}% of input — original may have heavy formatting`,
      );
    }
  }

  return {
    normalized: text,
    charsStripped: charsStrippedControl,
    quotesFolded,
    pageBreaksRemoved,
    warnings,
  };
}
