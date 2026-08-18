// Regex-first section detector.
//
// Epic and most EHR notes have predictable headers ("HPI:", "ASSESSMENT
// AND PLAN", "Past Medical History"). When we can find them with high
// confidence, we structure the note locally and skip the LLM call.
// When we can't, we still return the partial result and the caller
// decides whether to escalate to the LLM structurer.

import type { ParseConfidence, SectionKey } from '@/lib/types';

interface HeaderRule {
  key: SectionKey;
  // Patterns must match an entire line (we anchor with ^ / $ before use).
  // Order within a key array matters only for documentation — any match wins.
  patterns: RegExp[];
}

const HEADER_RULES: HeaderRule[] = [
  {
    key: 'chief_complaint',
    patterns: [
      /chief\s+complaint/i,
      /\bcc\b/i,
      /reason\s+for\s+(?:visit|admission|consult)/i,
    ],
  },
  {
    key: 'hpi',
    patterns: [
      /history\s+of\s+present\s+illness/i,
      /\bhpi\b/i,
      /present\s+illness/i,
      /interval\s+history/i,
    ],
  },
  {
    key: 'pmh',
    patterns: [
      /past\s+medical\s+history/i,
      /\bpmh(?:x)?\b/i,
      /medical\s+history/i,
      /problem\s+list/i,
      /active\s+problems/i,
    ],
  },
  {
    key: 'psh',
    patterns: [
      /past\s+surgical\s+history/i,
      /\bpsh(?:x)?\b/i,
      /surgical\s+history/i,
    ],
  },
  {
    key: 'medications',
    patterns: [
      /medications?(?:\s+on\s+admission|\s+at\s+home|\s+list)?/i,
      /\bmeds\b/i,
      /home\s+medications/i,
      /current\s+medications/i,
      /medication\s+reconciliation/i,
    ],
  },
  {
    key: 'allergies',
    patterns: [
      /allergies(?:\s+and\s+adverse\s+reactions)?/i,
      /\bnka\b/i,
      /\bnkda\b/i,
      /drug\s+allergies/i,
    ],
  },
  {
    key: 'social_history',
    patterns: [
      /social\s+history/i,
      /\bshx?\b/i,
    ],
  },
  {
    key: 'family_history',
    patterns: [
      /family\s+history/i,
      /\bfhx?\b/i,
    ],
  },
  {
    key: 'vitals',
    patterns: [
      /vital\s+signs?/i,
      /\bvitals?\b/i,
      /vs(?:\s|:)/i,
    ],
  },
  {
    key: 'physical_exam',
    patterns: [
      /physical\s+exam(?:ination)?/i,
      /\bpe\b/i,
      /exam(?:ination)?\b/i,
      /review\s+of\s+systems/i,
      /\bros\b/i,
    ],
  },
  {
    key: 'labs',
    patterns: [
      /lab(?:oratory)?\s+(?:results|data|values|studies)/i,
      /\blabs?\b/i,
      /diagnostic\s+studies/i,
    ],
  },
  {
    key: 'imaging',
    patterns: [
      /imaging(?:\s+(?:results|studies|findings))?/i,
      /radiology(?:\s+(?:results|reports?))?/i,
      /\bct\s+(?:findings|results|report)/i,
      /\bmri\s+(?:findings|results|report)/i,
      /chest\s+(?:x-?ray|radiograph)/i,
    ],
  },
  {
    key: 'assessment_plan',
    patterns: [
      /assessment\s+and\s+plan/i,
      /assessment\s*\/\s*plan/i,
      /\ba(?:ssessment)?\s*[\/&]\s*p(?:lan)?\b/i,
      /impression\s+and\s+plan/i,
      /clinical\s+impression/i,
      /assessment\b/i,
      /\bplan\b/i,
    ],
  },
];

interface DetectedHeader {
  index: number;
  key: SectionKey;
  rawHeader: string;
}

// Try to interpret a single line as a section header. Returns the matching
// SectionKey or null. We require the header to look like a header — short,
// optionally followed by a colon, optionally surrounded by formatting
// punctuation like ** or === — to avoid matching prose mentions like
// "the patient's medications include...".
function classifyHeader(line: string): SectionKey | null {
  const stripped = line
    .replace(/^[\s*#=\-_·•|>]+/, '')
    .replace(/[\s*#=\-_·•|>]+$/, '')
    .replace(/:\s*$/, '')
    .trim();

  if (stripped.length === 0 || stripped.length > 80) return null;

  // Headers usually have at most a couple of meaningful words. If the
  // line is long-ish and contains lowercase function words mid-line
  // ("the patient is on these medications") we reject it.
  if (stripped.length > 40 && /\s+(?:the|is|was|on|with|and)\s+/i.test(stripped)) {
    return null;
  }

  const looksLikeHeader =
    /:\s*$/.test(line.trim()) ||
    /^[A-Z][A-Z\s\/&,]+$/.test(stripped) ||
    /^\*\*.+\*\*$/.test(line.trim()) ||
    /^#+\s/.test(line.trim()) ||
    stripped.length <= 40;

  if (!looksLikeHeader) return null;

  for (const rule of HEADER_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(stripped)) {
        return rule.key;
      }
    }
  }
  return null;
}

export interface SectionDetectionResult {
  sections: Partial<Record<SectionKey, string>>;
  sectionsFound: number;
  confidence: ParseConfidence;
}

export function detectSections(text: string): SectionDetectionResult {
  if (!text || text.trim().length === 0) {
    return {
      sections: {},
      sectionsFound: 0,
      confidence: 'low',
    };
  }

  const lines = text.split('\n');
  const headers: DetectedHeader[] = [];
  for (let i = 0; i < lines.length; i++) {
    const key = classifyHeader(lines[i]);
    if (key) {
      headers.push({ index: i, key, rawHeader: lines[i] });
    }
  }

  const sections: Partial<Record<SectionKey, string>> = {};
  for (let h = 0; h < headers.length; h++) {
    const start = headers[h].index + 1;
    const end = h + 1 < headers.length ? headers[h + 1].index : lines.length;
    const body = lines.slice(start, end).join('\n').trim();
    if (body.length === 0) continue;
    // If the same section appears multiple times (interval notes, multiple
    // encounters), concatenate with a separator so nothing is lost.
    const existing = sections[headers[h].key];
    sections[headers[h].key] = existing
      ? `${existing}\n\n--- (continued) ---\n\n${body}`
      : body;
  }

  const sectionsFound = Object.keys(sections).length;

  // Confidence policy:
  //   ≥6 sections → high (clearly structured Epic-style note)
  //   3–5 sections → medium (some structure, escalate LLM in parallel)
  //   <3 sections → low (free-text dump, run LLM serially)
  let confidence: ParseConfidence;
  if (sectionsFound >= 6) confidence = 'high';
  else if (sectionsFound >= 3) confidence = 'medium';
  else confidence = 'low';

  return { sections, sectionsFound, confidence };
}

// Render structured sections as a tagged text block. Specialists prepend
// this to the existing patient JSON so prompts don't have to change.
export function renderSectionsBlock(
  sections: Partial<Record<SectionKey, string>>,
): string {
  const order: SectionKey[] = [
    'chief_complaint',
    'hpi',
    'pmh',
    'psh',
    'medications',
    'allergies',
    'social_history',
    'family_history',
    'vitals',
    'physical_exam',
    'labs',
    'imaging',
    'assessment_plan',
    'other',
  ];
  const labels: Record<SectionKey, string> = {
    chief_complaint: 'Chief Complaint',
    hpi: 'History of Present Illness',
    pmh: 'Past Medical History',
    psh: 'Past Surgical History',
    medications: 'Medications',
    allergies: 'Allergies',
    social_history: 'Social History',
    family_history: 'Family History',
    vitals: 'Vitals',
    physical_exam: 'Physical Exam',
    labs: 'Labs',
    imaging: 'Imaging',
    assessment_plan: 'Assessment & Plan',
    other: 'Other',
  };

  const parts: string[] = [];
  for (const key of order) {
    const body = sections[key];
    if (!body) continue;
    parts.push(`### ${labels[key]}\n${body.trim()}`);
  }
  return parts.join('\n\n');
}
