import Anthropic from '@anthropic-ai/sdk';
import { Specialist, SPECIALIST_CONFIG } from './types';
import type { IntakeData, SpecialistAnalysis, CrossConsultMessage, CrossConsultRound, TemporalIntakeData, SpecialistChatMessage, WebSearchCitation, SpecialistCalculationActivity, ParsedClinicalNote } from './types';
import { parseClinicalNote, renderSectionsBlock } from './parse';
import { INTAKE_PARSER_PROMPT } from './prompts/intake-parser';
import { ATTENDING_PROMPT } from './prompts/attending';
import { CARDIOLOGIST_PROMPT } from './prompts/cardiologist';
import { PULMONOLOGIST_PROMPT } from './prompts/pulmonologist';
import { NEPHROLOGIST_PROMPT } from './prompts/nephrologist';
import { HEPATOLOGIST_PROMPT } from './prompts/hepatologist';
import { HEMATOLOGIST_PROMPT } from './prompts/hematologist';
import { ID_SPECIALIST_PROMPT } from './prompts/id-specialist';
import { RADIOLOGIST_PROMPT } from './prompts/radiologist';
import { PHARMACIST_PROMPT } from './prompts/pharmacist';
import { ENDOCRINOLOGIST_PROMPT } from './prompts/endocrinologist';
import { NEUROLOGIST_PROMPT } from './prompts/neurologist';
import { INTENSIVIST_PROMPT } from './prompts/intensivist';
import { ONCOLOGIST_PROMPT } from './prompts/oncologist';
import { PSYCHIATRIST_PROMPT } from './prompts/psychiatrist';
import { TOXICOLOGIST_PROMPT } from './prompts/toxicologist';
import { PALLIATIVE_PROMPT } from './prompts/palliative';

const anthropic = new Anthropic();

// ─── Chart Text Sanitization ──────────────────────────────────────────────────
// Epic notes may contain embedded images, RTF artifacts, HTML, binary data,
// or other non-clinical content that breaks the intake parser.

function sanitizeChartText(rawText: string): { cleaned: string; warnings: string[] } {
  const warnings: string[] = [];
  let text = rawText;

  // 1. Strip base64-encoded image data (data:image/png;base64,...)
  const base64Pattern = /data:image\/[a-z]+;base64,[A-Za-z0-9+/=\s]{20,}/g;
  const base64Matches = text.match(base64Pattern);
  if (base64Matches) {
    warnings.push(`Stripped ${base64Matches.length} embedded base64 image(s)`);
    text = text.replace(base64Pattern, '[embedded image removed]');
  }

  // 2. Strip RTF formatting blocks
  const rtfPattern = /\{\\rtf1[\s\S]*?\}(?:\s*\})?/g;
  if (rtfPattern.test(text)) {
    warnings.push('Stripped RTF formatting blocks');
    text = text.replace(rtfPattern, '');
  }

  // 3. Strip HTML tags but preserve text content
  const htmlTagPattern = /<\/?(?:html|head|body|div|span|p|br|table|tr|td|th|img|a|b|i|u|em|strong|font|style|script|link|meta)[^>]*>/gi;
  if (htmlTagPattern.test(text)) {
    warnings.push('Stripped HTML tags');
    text = text.replace(htmlTagPattern, ' ');
  }

  // 4. Remove <style>...</style> and <script>...</script> blocks entirely
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');

  // 5. Strip image file references and placeholders
  const imageRefPattern = /\[(?:image|img|figure|photo|scan|screenshot)[^\]]*\]/gi;
  const imageRefMatches = text.match(imageRefPattern);
  if (imageRefMatches) {
    warnings.push(`Found ${imageRefMatches.length} image reference(s) — content not available for analysis`);
  }

  // 6. Strip binary / non-printable characters (keep newlines, tabs, standard ASCII + extended Latin)
  const binaryBefore = text.length;
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  const binaryStripped = binaryBefore - text.length;
  if (binaryStripped > 0) {
    warnings.push(`Stripped ${binaryStripped} non-printable character(s)`);
  }

  // 7. Strip common EHR artifact patterns
  // Page break markers, form feeds, printer codes
  text = text.replace(/\f/g, '\n');  // form feed → newline
  text = text.replace(/[\uFEFF\u200B\u200C\u200D\uFFFE]/g, ''); // BOM & zero-width chars

  // 8. Collapse excessive whitespace (>3 consecutive blank lines → 2)
  text = text.replace(/\n{4,}/g, '\n\n\n');

  // 9. Collapse excessive spaces (>10 in a row, likely table formatting)
  text = text.replace(/ {10,}/g, '  ');

  // 10. Trim and final check
  text = text.trim();

  if (text.length === 0 && rawText.length > 0) {
    warnings.push('WARNING: All content was removed during sanitization — original text may be non-clinical');
  }

  const reductionPct = rawText.length > 0
    ? Math.round((1 - text.length / rawText.length) * 100)
    : 0;
  if (reductionPct > 20) {
    warnings.push(`Sanitization removed ${reductionPct}% of input (${rawText.length} → ${text.length} chars)`);
  }

  return { cleaned: text, warnings };
}

// ─── Specialist Triage ────────────────────────────────────────────────────────
// After intake parsing, determine which specialists are actually relevant
// to avoid running unnecessary agents (saves cost and time).

const TRIAGE_PROMPT = `You are a clinical triage system. Given structured patient intake data, determine which medical specialists should be consulted.

AVAILABLE SPECIALISTS:
- cardiologist: Heart/cardiovascular issues, arrhythmias, heart failure, ACS, valvular disease
- pulmonologist: Lung/respiratory, ventilation, ARDS, pneumonia, oxygen management
- nephrologist: Kidney, electrolytes, acid-base, dialysis, AKI/CKD
- hepatologist: Liver disease, cirrhosis, hepatitis, MELD, ascites
- hematologist: Blood disorders, coagulopathy, anemia, transfusion, DIC, HIT
- id_specialist: Infections, antibiotics, sepsis, cultures, antimicrobial stewardship
- radiologist: Imaging interpretation, CT/MRI/X-ray/ultrasound findings
- pharmacist: Medication management, drug interactions, dosing, pharmacokinetics
- endocrinologist: Diabetes, DKA, thyroid, adrenal, glycemic management
- neurologist: Stroke, seizures, altered mental status, neuromuscular
- intensivist: Critical care, shock, vasopressors, ventilator management, ICU care
- oncologist: Cancer, tumors, chemotherapy complications, tumor lysis, neutropenic fever
- psychiatrist: Delirium, agitation, capacity, substance withdrawal, psychiatric emergencies
- toxicologist: Overdose, poisoning, toxidromes, antidotes, toxic exposures
- palliative: Goals of care, comfort care, hospice, code status, end-of-life, prognosis in serious illness

RULES:
1. ALWAYS include: pharmacist (every patient needs medication review)
2. ALWAYS include: radiologist (if ANY imaging is present)
3. Include specialists ONLY if the patient data shows relevant pathology, risk factors, or clinical questions
4. Consider patient demographics: age, sex, acuity
5. For young healthy patients with simple presentations, 3-5 specialists may be sufficient
6. For complex ICU patients, 8-12 may be appropriate
7. Do NOT include palliative unless: age >70 with serious illness, terminal diagnosis, goals of care mentioned, code status discussed, or multi-organ failure
8. Do NOT include oncologist unless: cancer history, suspicious masses, tumor markers elevated, or active chemotherapy
9. Do NOT include toxicologist unless: overdose, poisoning, toxic exposure, or unexplained anion/osmolal gap
10. Do NOT include psychiatrist unless: psychiatric history, delirium, agitation, altered mental status, substance use, or capacity concerns

Return ONLY a JSON object:
{
  "specialists": ["specialist_id", ...],
  "reasoning": "Brief explanation of why each was selected"
}`;

export async function triageSpecialists(intakeData: IntakeData): Promise<{
  specialists: Specialist[];
  reasoning: string;
}> {
  // Build a concise summary for triage (don't send raw_text to save tokens)
  const triageSummary = {
    demographics: intakeData.demographics,
    chief_complaint: intakeData.chief_complaint,
    hpi: intakeData.hpi?.slice(0, 1000),
    past_medical_history: intakeData.past_medical_history,
    medications: intakeData.medications?.map(m => m.name),
    allergies: intakeData.allergies,
    vitals: intakeData.vitals,
    labs_summary: intakeData.labs?.map(l => `${l.name}: ${l.value}${l.abnormal ? ' (abnormal)' : ''}`),
    imaging_present: intakeData.imaging?.length > 0,
    imaging_modalities: intakeData.imaging?.map(i => i.modality),
    ecg: intakeData.ecg ? 'present' : null,
    missing_data: intakeData.missing_data,
  };

  const response = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 1024,
    system: TRIAGE_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(triageSummary) }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonStr = extractJSON(text);

  if (!jsonStr) {
    console.warn('[triage] Failed to parse triage response, running all specialists');
    return {
      specialists: Object.values(Specialist).filter(s => s !== Specialist.ATTENDING),
      reasoning: 'Triage parsing failed — running all specialists as fallback',
    };
  }

  try {
    const parsed = JSON.parse(jsonStr);
    const validSpecialists = (parsed.specialists || [])
      .filter((s: string) => Object.values(Specialist).includes(s as Specialist) && s !== Specialist.ATTENDING)
      .map((s: string) => s as Specialist);

    // Always ensure at least pharmacist
    if (!validSpecialists.includes(Specialist.PHARMACIST)) {
      validSpecialists.push(Specialist.PHARMACIST);
    }

    console.log(`[triage] Selected ${validSpecialists.length} specialists: ${validSpecialists.join(', ')}`);
    console.log(`[triage] Reasoning: ${parsed.reasoning || 'none'}`);

    return {
      specialists: validSpecialists,
      reasoning: parsed.reasoning || '',
    };
  } catch {
    console.warn('[triage] JSON parse failed, running all specialists');
    return {
      specialists: Object.values(Specialist).filter(s => s !== Specialist.ATTENDING),
      reasoning: 'Triage JSON parse failed — running all specialists as fallback',
    };
  }
}

// Export sanitizer for use in API routes
export { sanitizeChartText };

const SPECIALIST_PROMPTS: Record<Specialist, string> = {
  [Specialist.ATTENDING]: ATTENDING_PROMPT,
  [Specialist.CARDIOLOGIST]: CARDIOLOGIST_PROMPT,
  [Specialist.PULMONOLOGIST]: PULMONOLOGIST_PROMPT,
  [Specialist.NEPHROLOGIST]: NEPHROLOGIST_PROMPT,
  [Specialist.HEPATOLOGIST]: HEPATOLOGIST_PROMPT,
  [Specialist.HEMATOLOGIST]: HEMATOLOGIST_PROMPT,
  [Specialist.ID_SPECIALIST]: ID_SPECIALIST_PROMPT,
  [Specialist.RADIOLOGIST]: RADIOLOGIST_PROMPT,
  [Specialist.PHARMACIST]: PHARMACIST_PROMPT,
  [Specialist.ENDOCRINOLOGIST]: ENDOCRINOLOGIST_PROMPT,
  [Specialist.NEUROLOGIST]: NEUROLOGIST_PROMPT,
  [Specialist.INTENSIVIST]: INTENSIVIST_PROMPT,
  [Specialist.ONCOLOGIST]: ONCOLOGIST_PROMPT,
  [Specialist.PSYCHIATRIST]: PSYCHIATRIST_PROMPT,
  [Specialist.TOXICOLOGIST]: TOXICOLOGIST_PROMPT,
  [Specialist.PALLIATIVE]: PALLIATIVE_PROMPT,
};

const SONNET_MODEL = 'claude-sonnet-4-5-20250929';
const OPUS_MODEL = 'claude-opus-4-6';

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305' as const,
  name: 'web_search' as const,
  max_uses: 3,
  allowed_domains: [
    'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'nih.gov', 'who.int', 'cdc.gov',
    'acc.org', 'heart.org', 'idsociety.org', 'ashp.org', 'kidney.org', 'aasld.org',
    'thoracic.org', 'aan.com', 'endocrine.org', 'hematology.org', 'acr.org',
    'nejm.org', 'thelancet.com', 'jamanetwork.com', 'bmj.com', 'cochranelibrary.com',
    'nice.org.uk', 'uptodate.com',
    'aahpm.org', 'asco.org', 'nccn.org', 'aact.org',
  ],
};

const CODE_EXECUTION_TOOL = {
  type: 'code_execution_20250522' as const,
  name: 'code_execution' as const,
};

function extractJSON(text: string): string | null {
  const jsonStart = text.indexOf('{');
  if (jsonStart === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = jsonStart; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(jsonStart, i + 1);
    }
  }
  return null;
}

export async function runIntake(rawText: string): Promise<{
  intakeData: TemporalIntakeData;
  sanitizationWarnings: string[];
  parsedNote: ParsedClinicalNote;
}> {
  // Step 0: ParseStage — universal note intake. Cleans Epic copy-paste
  // artifacts (smart quotes, page breaks, control chars), regex-detects
  // canonical sections, and (when needed) re-segments via Claude Haiku.
  const parsedNote = await parseClinicalNote(rawText);
  if (parsedNote.warnings.length > 0) {
    console.log(`[parse] Warnings:\n  - ${parsedNote.warnings.join('\n  - ')}`);
  }
  console.log(
    `[parse] confidence=${parsedNote.confidence} sectionsFound=${parsedNote.cleaningReport.sectionsFound} ` +
    `usedLLM=${parsedNote.cleaningReport.usedLLM} latency=${parsedNote.cleaningReport.latencyMs}ms`,
  );

  // Step 0b: defensive sanitizer — strips RTF / base64 / HTML residue
  // that the deterministic normalizer leaves in place.
  const { cleaned, warnings } = sanitizeChartText(parsedNote.normalized);

  if (warnings.length > 0) {
    console.log(`[intake] Sanitization warnings:\n  - ${warnings.join('\n  - ')}`);
  }

  if (cleaned.length === 0) {
    throw new Error('Chart text is empty after sanitization. The pasted content may contain only images or non-text data.');
  }

  console.log(`[intake] Parsing ${cleaned.length} chars (original: ${rawText.length} chars)`);

  // When ParseStage found canonical sections, prepend a structured block
  // so the intake LLM has an unambiguous segmentation to work from.
  const sectionsBlock = renderSectionsBlock(parsedNote.sections);
  const intakeInput = sectionsBlock
    ? `# STRUCTURED SECTIONS (verbatim from chart)\n${sectionsBlock}\n\n# RAW NORMALIZED TEXT\n${cleaned}`
    : cleaned;

  const response = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 16384,
    system: INTAKE_PARSER_PROMPT,
    messages: [
      { role: 'user', content: intakeInput },
      { role: 'assistant', content: '{' },
    ],
  });

  const rawText2 = response.content[0].type === 'text' ? response.content[0].text : '';
  const text = '{' + rawText2;
  if (response.stop_reason === 'max_tokens') {
    console.warn(`[intake] Response truncated at max_tokens (${16384}). Chart may be too large.`);
  }
  const jsonStr = extractJSON(text);
  if (!jsonStr) {
    console.error('[intake] No JSON found in parser response. First 500 chars:', text.slice(0, 500));
    throw new Error(
      'Failed to parse clinical notes. The text may contain unsupported formatting. ' +
      'Try pasting plain text from the chart instead of rich-formatted content.'
    );
  }

  let parsed: TemporalIntakeData;
  try {
    parsed = JSON.parse(jsonStr) as TemporalIntakeData;
  } catch (e) {
    console.error('[intake] JSON parse error:', (e as Error).message);
    console.error('[intake] Attempted to parse:', jsonStr.slice(0, 500));
    throw new Error(
      'Failed to parse structured data from clinical notes. ' +
      'This may be caused by unusual formatting in the chart. Try removing any images or special formatting.'
    );
  }
  parsed.raw_text = rawText;

  // Ensure temporal fields have defaults for backward compatibility
  if (!parsed.encounters) parsed.encounters = [];
  if (!parsed.timeline_summary) parsed.timeline_summary = '';
  if (!parsed.date_range) parsed.date_range = { start: '', end: '' };

  console.log(`[intake] Successfully parsed: ${parsed.chief_complaint || 'no chief complaint'}, ` +
    `${parsed.labs?.length || 0} labs, ${parsed.imaging?.length || 0} imaging, ` +
    `${parsed.encounters?.length || 0} encounters`);

  return { intakeData: parsed, sanitizationWarnings: warnings, parsedNote };
}

export async function runIncrementalIntake(
  newRawText: string,
  existingIntake: IntakeData
): Promise<TemporalIntakeData> {
  // Sanitize new notes before parsing
  const { cleaned, warnings } = sanitizeChartText(newRawText);
  if (warnings.length > 0) {
    console.log(`[incremental-intake] Sanitization warnings:\n  - ${warnings.join('\n  - ')}`);
  }
  if (cleaned.length === 0) {
    throw new Error('Additional notes are empty after sanitization. The pasted content may contain only images or non-text data.');
  }

  const incrementalPrompt = `You are parsing ADDITIONAL clinical notes to merge with an existing patient record.

EXISTING PATIENT DATA (do NOT re-parse this, it is already structured):
${JSON.stringify(existingIntake, null, 2)}

YOUR TASK:
1. Parse ONLY the NEW notes below into structured encounter data.
2. Merge the new encounters with any existing encounters.
3. Update the aggregate/flat fields (demographics, vitals, labs, etc.) to reflect the MOST RECENT values from all encounters combined.
4. Update the timeline_summary to incorporate the new data.
5. Update the date_range to span all encounters.

Return the COMPLETE updated TemporalIntakeData JSON object (existing + new data merged).
The output format is the same as the intake parser: all the flat fields plus encounters, timeline_summary, and date_range.

Return ONLY the JSON object, with no additional text or markdown formatting.

NEW NOTES TO PARSE AND MERGE:`;

  const response = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 8192,
    system: incrementalPrompt,
    messages: [{ role: 'user', content: cleaned }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonStr = extractJSON(text);
  if (!jsonStr) {
    console.error('[incremental-intake] No JSON found. First 500 chars:', text.slice(0, 500));
    throw new Error('Failed to parse additional notes. Try pasting plain text without images or special formatting.');
  }

  let parsed: TemporalIntakeData;
  try {
    parsed = JSON.parse(jsonStr) as TemporalIntakeData;
  } catch (e) {
    console.error('[incremental-intake] JSON parse error:', (e as Error).message);
    throw new Error('Failed to parse additional notes: invalid structured data.');
  }

  // Preserve the combined raw text
  parsed.raw_text = (existingIntake.raw_text || '') + '\n\n---\n\n' + newRawText;

  // Ensure temporal fields have defaults
  if (!parsed.encounters) parsed.encounters = [];
  if (!parsed.timeline_summary) parsed.timeline_summary = '';
  if (!parsed.date_range) parsed.date_range = { start: '', end: '' };

  return parsed;
}

interface SpecialistToolOptions {
  webSearchEnabled?: boolean;
  onSearch?: (specialist: string, query: string) => void;
  onCalculation?: (specialist: string, code: string) => void;
  // Optional ParseStage output. When provided, specialists receive the
  // verbatim section block in addition to the structured intake JSON.
  parsedNote?: ParsedClinicalNote;
}

function buildToolsArray(options?: SpecialistToolOptions): unknown[] {
  const tools: unknown[] = [CODE_EXECUTION_TOOL];
  if (options?.webSearchEnabled) {
    tools.push(WEB_SEARCH_TOOL);
  }
  return tools;
}

async function runSingleSpecialist(
  specialist: Specialist,
  intakeData: IntakeData,
  options?: SpecialistToolOptions
): Promise<SpecialistAnalysis> {
  const config = SPECIALIST_CONFIG[specialist];
  const model = config.model === 'opus' ? OPUS_MODEL : SONNET_MODEL;

  // Prepend a verbatim section block when ParseStage was able to detect
  // canonical sections. Falls back silently to the structured JSON only.
  const parsedNote = options?.parsedNote;
  const sectionsBlock = parsedNote
    ? renderSectionsBlock(parsedNote.sections)
    : '';
  const noteContext = sectionsBlock
    ? `## Verbatim chart sections (preserved from source)\n${sectionsBlock}\n\n## Structured intake data\n${JSON.stringify(intakeData, null, 2)}`
    : `${JSON.stringify(intakeData, null, 2)}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createParams: any = {
    model,
    max_tokens: 8192,
    system: SPECIALIST_PROMPTS[specialist],
    messages: [{
      role: 'user',
      content: `Analyze the following patient data:\n\n${noteContext}`,
    }],
  };

  createParams.tools = buildToolsArray(options);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = await (anthropic.beta.messages.create as any)({
    ...createParams,
    betas: ['code-execution-2025-05-22'],
  });

  // Extract text and citations from response content blocks
  let text = '';
  const citations: WebSearchCitation[] = [];
  const calculations: SpecialistCalculationActivity[] = [];
  const pendingCodeExecution = new Map<string, string>();

  for (const block of response.content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'server_tool_use' && block.name === 'web_search') {
      // Fire search callback with the query
      const input = block.input as { query?: string };
      if (options?.onSearch && input?.query) {
        options.onSearch(specialist, input.query);
      }
    } else if (block.type === 'web_search_tool_result') {
      // Extract citations from search results
      const content = (block as unknown as { content: Array<{ type: string; url?: string; title?: string; page_age?: string }> }).content;
      if (Array.isArray(content)) {
        for (const result of content) {
          if (result.type === 'web_search_result' && result.url && result.title) {
            citations.push({
              title: result.title,
              url: result.url,
              page_age: result.page_age,
            });
          }
        }
      }
    } else if (block.type === 'server_tool_use' && block.name === 'code_execution') {
      const input = block.input as { code?: string };
      pendingCodeExecution.set(block.id, input?.code || '');
      if (options?.onCalculation && input?.code) {
        options.onCalculation(specialist, input.code);
      }
    } else if (block.type === 'code_execution_tool_result') {
      const result = block as unknown as {
        content?: { type?: string; stdout?: string; return_code?: number };
        tool_use_id?: string;
      };
      const content = result.content;
      const code = pendingCodeExecution.get(result.tool_use_id ?? '') || '';
      if (content?.type === 'code_execution_result') {
        calculations.push({
          specialist,
          code,
          result: content.stdout || '',
          success: content.return_code === 0,
          timestamp: Date.now(),
        });
      }
    }
  }

  const jsonStr = extractJSON(text);
  if (!jsonStr) {
    console.error(`[orchestrator] ${specialist} no JSON found. Response starts with:`, text.slice(0, 200));
    throw new Error(`Failed to parse ${specialist} analysis`);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error(`[orchestrator] ${specialist} JSON parse error:`, (e as Error).message, 'First 200 chars:', jsonStr.slice(0, 200));
    throw new Error(`Failed to parse ${specialist} analysis: invalid JSON`);
  }

  const analysis = { specialist, ...parsed } as SpecialistAnalysis;

  // Attach citations if any were found
  if (citations.length > 0) {
    analysis.web_search_citations = citations;
  }

  if (calculations.length > 0) {
    analysis.calculations_performed = calculations;
  }

  return analysis;
}

export async function runSpecialists(
  intakeData: IntakeData,
  selectedSpecialists?: Specialist[]
): Promise<Record<string, SpecialistAnalysis>> {
  const specialists = selectedSpecialists || Object.values(Specialist);

  const results = await Promise.allSettled(
    specialists.map((s) => runSingleSpecialist(s, intakeData))
  );

  const analyses: Record<string, SpecialistAnalysis> = {};
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      analyses[result.value.specialist] = result.value;
    } else {
      console.error(`[orchestrator] ${specialists[i]} failed:`, result.reason?.message ?? result.reason);
      // Provide a minimal fallback so the case can still proceed
      analyses[specialists[i]] = {
        specialist: specialists[i],
        findings: ['Analysis unavailable — specialist returned an error.'],
        concerns: [],
        recommendations: [],
        questions_for_user: [],
        questions_for_team: [],
        cross_consults: [],
        scoring_systems_applied: [],
      };
    }
  }
  return analyses;
}

export async function runSpecialistsStreaming(
  intakeData: IntakeData,
  onResult: (specialist: Specialist, analysis: SpecialistAnalysis) => void,
  onError: (specialist: Specialist, error: string) => void,
  options?: SpecialistToolOptions,
  selectedSpecialists?: Specialist[]
): Promise<Record<string, SpecialistAnalysis>> {
  // Use selected specialists if provided, otherwise run all
  const specialists = selectedSpecialists || Object.values(Specialist);
  const analyses: Record<string, SpecialistAnalysis> = {};

  console.log(`[specialists] Running ${specialists.length} specialists: ${specialists.join(', ')}`);

  await Promise.allSettled(
    specialists.map(async (s) => {
      try {
        const analysis = await runSingleSpecialist(s, intakeData, options);
        analyses[s] = analysis;
        onResult(s, analysis);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[orchestrator] ${s} failed:`, errorMsg);
        const fallback: SpecialistAnalysis = {
          specialist: s,
          findings: ['Analysis unavailable — specialist returned an error.'],
          concerns: [],
          recommendations: [],
          questions_for_user: [],
          questions_for_team: [],
          cross_consults: [],
          scoring_systems_applied: [],
        };
        analyses[s] = fallback;
        onError(s, errorMsg);
      }
    })
  );

  return analyses;
}

export async function runCrossConsultStreaming(
  analyses: Record<string, SpecialistAnalysis>,
  intakeData: IntakeData,
  onMessage: (msg: CrossConsultMessage) => void
): Promise<CrossConsultMessage[]> {
  // 1. Collect explicit cross-consult requests
  const requests: Array<{ from: Specialist; to: string; question: string }> = [];
  for (const [specialist, analysis] of Object.entries(analyses)) {
    if (Array.isArray(analysis.cross_consults)) {
      for (const cc of analysis.cross_consults) {
        requests.push({ from: specialist as Specialist, to: cc.to, question: cc.question });
      }
    }
  }

  // 2. Convert questions_for_team into cross-consult requests via keyword routing
  for (const [specialist, analysis] of Object.entries(analyses)) {
    const teamQs = Array.isArray(analysis.questions_for_team) ? analysis.questions_for_team : [];
    for (const q of teamQs) {
      if (typeof q !== 'string' || !q.trim()) continue;
      const target = routeTeamQuestion(q, specialist);
      if (target) {
        const alreadyRouted = requests.some(
          (r) => r.from === specialist && r.to === target && r.question === q
        );
        if (!alreadyRouted) {
          requests.push({ from: specialist as Specialist, to: target, question: q });
        }
      }
    }
  }

  if (requests.length === 0) return [];

  const allMessages: CrossConsultMessage[] = [];

  await Promise.allSettled(
    requests.map(async (req) => {
      const targetAnalysis = analyses[req.to];
      if (!targetAnalysis) return;

      const response = await anthropic.messages.create({
        model: SONNET_MODEL,
        max_tokens: 2048,
        system: SPECIALIST_PROMPTS[req.to as Specialist],
        messages: [{
          role: 'user',
          content: `A colleague in ${req.from} asks: "${req.question}"\n\nYour previous analysis: ${JSON.stringify(targetAnalysis)}\n\nPatient data: ${JSON.stringify(intakeData)}\n\nRespond to their question concisely.`,
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const msg: CrossConsultMessage = {
        from: req.from,
        to: req.to as Specialist,
        message: req.question,
        response: text,
      };
      allMessages.push(msg);
      onMessage(msg);
    })
  );

  return allMessages;
}

const SPECIALTY_KEYWORDS: Record<string, Specialist> = {
  // Cardiology
  cardiac: Specialist.CARDIOLOGIST, heart: Specialist.CARDIOLOGIST, echo: Specialist.CARDIOLOGIST,
  troponin: Specialist.CARDIOLOGIST, stemi: Specialist.CARDIOLOGIST, nstemi: Specialist.CARDIOLOGIST,
  arrhythmia: Specialist.CARDIOLOGIST, afib: Specialist.CARDIOLOGIST, gdmt: Specialist.CARDIOLOGIST,
  ejection: Specialist.CARDIOLOGIST, bnp: Specialist.CARDIOLOGIST, valvular: Specialist.CARDIOLOGIST,
  // Pulmonology
  pulmonary: Specialist.PULMONOLOGIST, respiratory: Specialist.PULMONOLOGIST, ventilat: Specialist.PULMONOLOGIST,
  abg: Specialist.PULMONOLOGIST, oxygen: Specialist.PULMONOLOGIST, ards: Specialist.PULMONOLOGIST,
  pneumonia: Specialist.PULMONOLOGIST, sepsis: Specialist.PULMONOLOGIST, intubat: Specialist.PULMONOLOGIST,
  // Nephrology
  renal: Specialist.NEPHROLOGIST, kidney: Specialist.NEPHROLOGIST, creatinine: Specialist.NEPHROLOGIST,
  dialysis: Specialist.NEPHROLOGIST, electrolyte: Specialist.NEPHROLOGIST, potassium: Specialist.NEPHROLOGIST,
  sodium: Specialist.NEPHROLOGIST, 'acid-base': Specialist.NEPHROLOGIST, gfr: Specialist.NEPHROLOGIST,
  // Hepatology
  liver: Specialist.HEPATOLOGIST, hepat: Specialist.HEPATOLOGIST, cirrhosis: Specialist.HEPATOLOGIST,
  meld: Specialist.HEPATOLOGIST, ascites: Specialist.HEPATOLOGIST, bilirubin: Specialist.HEPATOLOGIST,
  encephalopathy: Specialist.HEPATOLOGIST,
  // Hematology
  coagul: Specialist.HEMATOLOGIST, platelet: Specialist.HEMATOLOGIST, anemia: Specialist.HEMATOLOGIST,
  transfus: Specialist.HEMATOLOGIST, hit: Specialist.HEMATOLOGIST, ttp: Specialist.HEMATOLOGIST,
  dic: Specialist.HEMATOLOGIST, anticoagul: Specialist.HEMATOLOGIST, inr: Specialist.HEMATOLOGIST,
  // Infectious Disease
  antibiotic: Specialist.ID_SPECIALIST, infection: Specialist.ID_SPECIALIST, culture: Specialist.ID_SPECIALIST,
  'c. diff': Specialist.ID_SPECIALIST, septic: Specialist.ID_SPECIALIST, fever: Specialist.ID_SPECIALIST,
  antimicrobial: Specialist.ID_SPECIALIST, mrsa: Specialist.ID_SPECIALIST,
  // Radiology
  imaging: Specialist.RADIOLOGIST, 'ct ': Specialist.RADIOLOGIST, mri: Specialist.RADIOLOGIST,
  xray: Specialist.RADIOLOGIST, 'x-ray': Specialist.RADIOLOGIST, ultrasound: Specialist.RADIOLOGIST,
  // Pharmacy
  drug: Specialist.PHARMACIST, medication: Specialist.PHARMACIST, dose: Specialist.PHARMACIST,
  dosing: Specialist.PHARMACIST, interaction: Specialist.PHARMACIST, pharmacok: Specialist.PHARMACIST,
  // Endocrinology
  insulin: Specialist.ENDOCRINOLOGIST, glucose: Specialist.ENDOCRINOLOGIST, diabet: Specialist.ENDOCRINOLOGIST,
  dka: Specialist.ENDOCRINOLOGIST, thyroid: Specialist.ENDOCRINOLOGIST, adrenal: Specialist.ENDOCRINOLOGIST,
  a1c: Specialist.ENDOCRINOLOGIST, glycemic: Specialist.ENDOCRINOLOGIST,
  // Neurology
  neuro: Specialist.NEUROLOGIST, stroke: Specialist.NEUROLOGIST, seizure: Specialist.NEUROLOGIST,
  'mental status': Specialist.NEUROLOGIST, nihss: Specialist.NEUROLOGIST, gcs: Specialist.NEUROLOGIST,
  // Critical Care
  shock: Specialist.INTENSIVIST, vasopressor: Specialist.INTENSIVIST, norepinephrine: Specialist.INTENSIVIST,
  sofa: Specialist.INTENSIVIST, resuscitat: Specialist.INTENSIVIST, pressors: Specialist.INTENSIVIST,
  sedation: Specialist.INTENSIVIST, 'icu bundle': Specialist.INTENSIVIST, inotrope: Specialist.INTENSIVIST,
  'post-arrest': Specialist.INTENSIVIST, ttm: Specialist.INTENSIVIST, prone: Specialist.INTENSIVIST,
  // Oncology
  cancer: Specialist.ONCOLOGIST, tumor: Specialist.ONCOLOGIST, malignancy: Specialist.ONCOLOGIST, chemo: Specialist.ONCOLOGIST,
  neutropenic: Specialist.ONCOLOGIST, 'tumor lysis': Specialist.ONCOLOGIST, immunotherapy: Specialist.ONCOLOGIST,
  metasta: Specialist.ONCOLOGIST, oncolog: Specialist.ONCOLOGIST, iraes: Specialist.ONCOLOGIST,
  // Psychiatry
  delirium: Specialist.PSYCHIATRIST, agitat: Specialist.PSYCHIATRIST, capacity: Specialist.PSYCHIATRIST,
  psych: Specialist.PSYCHIATRIST, hallucin: Specialist.PSYCHIATRIST, suicid: Specialist.PSYCHIATRIST,
  catatoni: Specialist.PSYCHIATRIST, ciwa: Specialist.PSYCHIATRIST, cows: Specialist.PSYCHIATRIST,
  antipsychotic: Specialist.PSYCHIATRIST, 'substance withdrawal': Specialist.PSYCHIATRIST,
  // Toxicology
  overdose: Specialist.TOXICOLOGIST, poison: Specialist.TOXICOLOGIST, ingestion: Specialist.TOXICOLOGIST,
  toxidrome: Specialist.TOXICOLOGIST, antidote: Specialist.TOXICOLOGIST, 'osmolal gap': Specialist.TOXICOLOGIST,
  acetaminophen: Specialist.TOXICOLOGIST, 'toxic alcohol': Specialist.TOXICOLOGIST, methanol: Specialist.TOXICOLOGIST,
  'ethylene glycol': Specialist.TOXICOLOGIST, envenomation: Specialist.TOXICOLOGIST, naloxone: Specialist.TOXICOLOGIST,
  fomepizole: Specialist.TOXICOLOGIST,
  // Palliative Care
  'goals of care': Specialist.PALLIATIVE, comfort: Specialist.PALLIATIVE, hospice: Specialist.PALLIATIVE,
  'code status': Specialist.PALLIATIVE, prognos: Specialist.PALLIATIVE, 'advance directive': Specialist.PALLIATIVE,
  'end of life': Specialist.PALLIATIVE, dnr: Specialist.PALLIATIVE, 'withdrawal of care': Specialist.PALLIATIVE,
};

function routeTeamQuestion(question: string, fromSpecialist: string): Specialist | null {
  const q = question.toLowerCase();
  for (const [keyword, target] of Object.entries(SPECIALTY_KEYWORDS)) {
    if (q.includes(keyword) && target !== fromSpecialist) {
      return target;
    }
  }
  return null;
}

export async function runCrossConsult(
  analyses: Record<string, SpecialistAnalysis>,
  intakeData: IntakeData
): Promise<CrossConsultMessage[]> {
  // 1. Collect explicit cross-consult requests from specialist outputs
  const requests: Array<{ from: Specialist; to: string; question: string }> = [];
  for (const [specialist, analysis] of Object.entries(analyses)) {
    if (Array.isArray(analysis.cross_consults)) {
      for (const cc of analysis.cross_consults) {
        requests.push({ from: specialist as Specialist, to: cc.to, question: cc.question });
      }
    }
  }

  // 2. Convert questions_for_team into cross-consult requests via keyword routing
  for (const [specialist, analysis] of Object.entries(analyses)) {
    const teamQs = Array.isArray(analysis.questions_for_team) ? analysis.questions_for_team : [];
    for (const q of teamQs) {
      if (typeof q !== 'string' || !q.trim()) continue;
      const target = routeTeamQuestion(q, specialist);
      if (target) {
        // Avoid duplicate routes to the same specialist with the same question
        const alreadyRouted = requests.some(
          (r) => r.from === specialist && r.to === target && r.question === q
        );
        if (!alreadyRouted) {
          requests.push({ from: specialist as Specialist, to: target, question: q });
        }
      }
    }
  }

  if (requests.length === 0) return [];

  // Run cross-consult responses in parallel
  const messages = await Promise.all(
    requests.map(async (req) => {
      const targetAnalysis = analyses[req.to];
      if (!targetAnalysis) return null;

      const response = await anthropic.messages.create({
        model: SONNET_MODEL,
        max_tokens: 2048,
        system: SPECIALIST_PROMPTS[req.to as Specialist],
        messages: [{
          role: 'user',
          content: `A colleague in ${req.from} asks: "${req.question}"\n\nYour previous analysis: ${JSON.stringify(targetAnalysis)}\n\nPatient data: ${JSON.stringify(intakeData)}\n\nRespond to their question concisely.`,
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      return {
        from: req.from,
        to: req.to as Specialist,
        message: req.question,
        response: text,
      } as CrossConsultMessage;
    })
  );

  return messages.filter(Boolean) as CrossConsultMessage[];
}

export async function runMultiRoundCrossConsult(
  analyses: Record<string, SpecialistAnalysis>,
  intakeData: IntakeData,
  callbacks: {
    onRoundStart: (round: number) => void;
    onMessage: (round: number, msg: CrossConsultMessage) => void;
    onRoundDone: (round: number, newQuestionsCount: number) => void;
  },
  maxRounds: number = 3
): Promise<CrossConsultRound[]> {
  const rounds: CrossConsultRound[] = [];

  // Collect initial requests (same logic as runCrossConsultStreaming)
  let pendingRequests: Array<{ from: Specialist; to: Specialist; question: string }> = [];

  for (const [specialist, analysis] of Object.entries(analyses)) {
    if (Array.isArray(analysis.cross_consults)) {
      for (const cc of analysis.cross_consults) {
        pendingRequests.push({ from: specialist as Specialist, to: cc.to as Specialist, question: cc.question });
      }
    }
  }
  for (const [specialist, analysis] of Object.entries(analyses)) {
    const teamQs = Array.isArray(analysis.questions_for_team) ? analysis.questions_for_team : [];
    for (const q of teamQs) {
      if (typeof q !== 'string' || !q.trim()) continue;
      const target = routeTeamQuestion(q, specialist);
      if (target) {
        const alreadyRouted = pendingRequests.some(
          (r) => r.from === specialist && r.to === target && r.question === q
        );
        if (!alreadyRouted) {
          pendingRequests.push({ from: specialist as Specialist, to: target, question: q });
        }
      }
    }
  }

  for (let round = 1; round <= maxRounds; round++) {
    if (pendingRequests.length === 0) break;

    callbacks.onRoundStart(round);
    const roundMessages: CrossConsultMessage[] = [];
    const nextRequests: Array<{ from: Specialist; to: Specialist; question: string }> = [];

    await Promise.allSettled(
      pendingRequests.map(async (req) => {
        const targetAnalysis = analyses[req.to];
        if (!targetAnalysis) return;

        const response = await anthropic.messages.create({
          model: SONNET_MODEL,
          max_tokens: 2048,
          system: SPECIALIST_PROMPTS[req.to],
          messages: [{
            role: 'user',
            content: `A colleague in ${req.from} asks: "${req.question}"

Your previous analysis: ${JSON.stringify(targetAnalysis)}

Patient data: ${JSON.stringify(intakeData)}

Respond to their question concisely. Return your answer as JSON:
{
  "response": "your concise response text here",
  "new_questions": [{"to": "specialist_id", "question": "follow-up question"}]
}

If you have no follow-up questions, use an empty array for new_questions.`,
          }],
        });

        const rawText = response.content[0].type === 'text' ? response.content[0].text : '';

        // Try to parse JSON response for new_questions
        let responseText = rawText;
        let newQuestions: Array<{ to: string; question: string }> = [];

        const jsonStr = extractJSON(rawText);
        if (jsonStr) {
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.response) responseText = parsed.response;
            if (Array.isArray(parsed.new_questions)) {
              newQuestions = parsed.new_questions.filter(
                (nq: { to?: string; question?: string }) => nq.to && nq.question
              );
            }
          } catch {
            // If JSON parse fails, use raw text as response
            responseText = rawText;
          }
        }

        const msg: CrossConsultMessage = {
          from: req.from,
          to: req.to,
          message: req.question,
          response: responseText,
        };
        roundMessages.push(msg);
        callbacks.onMessage(round, msg);

        // Queue new questions for next round
        for (const nq of newQuestions) {
          const targetSpecialist = nq.to as Specialist;
          if (Object.values(Specialist).includes(targetSpecialist) && targetSpecialist !== req.to) {
            nextRequests.push({
              from: req.to,
              to: targetSpecialist,
              question: nq.question,
            });
          }
        }
      })
    );

    rounds.push({ round, messages: roundMessages });
    callbacks.onRoundDone(round, nextRequests.length);

    pendingRequests = nextRequests;
  }

  return rounds;
}

export async function runAdditionalData(
  answers: Record<string, string | null>,
  previousAnalyses: Record<string, SpecialistAnalysis>,
  intakeData: IntakeData
): Promise<Record<string, SpecialistAnalysis>> {
  const additionalContext = Object.entries(answers)
    .filter(([, v]) => v !== null)
    .map(([q, a]) => `Q: ${q}\nA: ${a}`)
    .join('\n\n');

  if (!additionalContext) return previousAnalyses;

  // Re-run all specialists with additional data
  const specialists = Object.values(Specialist);
  const results = await Promise.all(
    specialists.map(async (s) => {
      const config = SPECIALIST_CONFIG[s];
      const model = config.model === 'opus' ? OPUS_MODEL : SONNET_MODEL;

      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        system: SPECIALIST_PROMPTS[s],
        messages: [{
          role: 'user',
          content: `Analyze the following patient data:\n\n${JSON.stringify(intakeData, null, 2)}\n\nADDITIONAL DATA PROVIDED:\n${additionalContext}\n\nYour previous analysis:\n${JSON.stringify(previousAnalyses[s], null, 2)}\n\nUpdate your analysis with the new information.`,
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const jsonStr = extractJSON(text);
      if (!jsonStr) return previousAnalyses[s];

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        return previousAnalyses[s];
      }
      return { specialist: s, ...parsed } as SpecialistAnalysis;
    })
  );

  const analyses: Record<string, SpecialistAnalysis> = {};
  for (const result of results) {
    analyses[result.specialist] = result;
  }
  return analyses;
}

// Condense specialist analysis to essential fields for synthesis prompt
function condenseSynthesisInput(
  analyses: Record<string, SpecialistAnalysis>,
  crossConsults: CrossConsultMessage[],
  intakeData: IntakeData
): { patientSummary: string; analystSummaries: string; consultNotes: string } {
  // Compact patient data — drop raw notes, keep structured fields
  const patientSummary = JSON.stringify({
    demographics: intakeData.demographics,
    chief_complaint: intakeData.chief_complaint,
    hpi: intakeData.hpi,
    active_problems: (intakeData as { active_problems?: unknown }).active_problems,
    medications: intakeData.medications,
    vitals: intakeData.vitals,
    labs: intakeData.labs,
  });

  // Compact each specialist to findings/concerns/recommendations only
  const analystSummaries = Object.entries(analyses)
    .map(([specialist, analysis]) => {
      const parts = [`## ${SPECIALIST_CONFIG[specialist as Specialist]?.name ?? specialist}`];
      if (analysis.findings?.length) parts.push(`Findings: ${analysis.findings.join('; ')}`);
      if (analysis.concerns?.length) {
        parts.push(`Concerns: ${analysis.concerns.map(c => `[${c.severity}] ${c.detail}`).join('; ')}`);
      }
      if (analysis.recommendations?.length) {
        parts.push(`Recommendations: ${analysis.recommendations.map(r => {
          let s = r.recommendation;
          if (r.rationale) s += ` (${r.rationale})`;
          return s;
        }).join('; ')}`);
      }
      const evidenceBasis = (analysis as { evidence_basis?: string }).evidence_basis;
      if (evidenceBasis) parts.push(`Evidence: ${evidenceBasis}`);
      return parts.join('\n');
    })
    .join('\n\n');

  // Compact cross-consults — just from/to/message, no metadata
  const consultNotes = crossConsults
    .map(cc => `${SPECIALIST_CONFIG[cc.from as Specialist]?.name ?? cc.from} → ${SPECIALIST_CONFIG[cc.to as Specialist]?.name ?? cc.to}: ${cc.message}`)
    .join('\n');

  return { patientSummary, analystSummaries, consultNotes };
}

export async function* runSynthesis(
  analyses: Record<string, SpecialistAnalysis>,
  crossConsults: CrossConsultMessage[],
  intakeData: IntakeData
): AsyncGenerator<string> {
  const { patientSummary, analystSummaries, consultNotes } = condenseSynthesisInput(analyses, crossConsults, intakeData);

  const stream = anthropic.messages.stream({
    model: OPUS_MODEL,
    max_tokens: 8192,
    system: ATTENDING_PROMPT,
    messages: [{
      role: 'user',
      content: `SYNTHESIZE the following specialist analyses into a unified Assessment & Plan organized by problem.

PATIENT DATA:
${patientSummary}

SPECIALIST ANALYSES:
${analystSummaries}

${consultNotes ? `CROSS-CONSULTATION NOTES:\n${consultNotes}` : ''}

Generate a problem-oriented A/P. For each problem:
- List the assessment
- List specific recommendations with the specialist who suggested them in parentheses
- Include guideline citations inline
- Flag areas of specialist disagreement
- Note confidence levels

Format as plain text suitable for pasting into Epic. Do NOT use markdown formatting.`,
    }],
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}

export async function runSpecialistChat(
  specialist: Specialist,
  question: string,
  fullContext: {
    intakeData: IntakeData;
    analyses: Record<string, SpecialistAnalysis>;
    crossConsults: CrossConsultMessage[];
    chatHistory: SpecialistChatMessage[];
    synthesizedPlan: string;
  }
): Promise<{ response: string; triggeredQuestions: Array<{ to: string; question: string }> }> {
  const config = SPECIALIST_CONFIG[specialist];
  const model = config.model === 'opus' ? OPUS_MODEL : SONNET_MODEL;

  // Build chat history context
  const chatHistoryContext = fullContext.chatHistory
    .map((msg) => {
      const role = msg.role === 'user' ? 'Clinician' : `${SPECIALIST_CONFIG[msg.specialist!]?.name ?? msg.specialist}`;
      return `${role}: ${msg.content}`;
    })
    .join('\n');

  // Build relevant cross-consult context for this specialist
  const relevantConsults = fullContext.crossConsults.filter(
    (cc) => cc.from === specialist || cc.to === specialist
  );

  const userMessage = `You are being asked a follow-up question by the clinician reviewing this case.

PATIENT SUMMARY:
Demographics: ${JSON.stringify(fullContext.intakeData.demographics)}
Chief Complaint: ${fullContext.intakeData.chief_complaint}
HPI: ${fullContext.intakeData.hpi}

YOUR PREVIOUS ANALYSIS:
${JSON.stringify(fullContext.analyses[specialist], null, 2)}

${relevantConsults.length > 0 ? `RELEVANT CROSS-CONSULTATION HISTORY:\n${JSON.stringify(relevantConsults, null, 2)}` : ''}

${fullContext.synthesizedPlan ? `SYNTHESIZED PLAN SUMMARY:\n${fullContext.synthesizedPlan.slice(0, 2000)}` : ''}

${chatHistoryContext ? `PREVIOUS CHAT MESSAGES:\n${chatHistoryContext}` : ''}

CLINICIAN'S QUESTION:
${question}

Respond with a JSON object:
{
  "response": "Your detailed answer to the clinician's question",
  "new_questions": [{"to": "specialist_enum_value", "question": "question for that specialist"}]
}

The "new_questions" array should contain questions for other specialists ONLY if the clinician's question raises cross-specialty concerns that need input from another team member. Usually this array will be empty.

Respond ONLY with the JSON object.`;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system: SPECIALIST_PROMPTS[specialist],
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  const jsonStr = extractJSON(text);
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      return {
        response: parsed.response ?? text,
        triggeredQuestions: Array.isArray(parsed.new_questions) ? parsed.new_questions : [],
      };
    } catch {
      // Fall through to plain text response
    }
  }

  return { response: text, triggeredQuestions: [] };
}
