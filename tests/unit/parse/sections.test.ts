import { describe, it, expect } from 'vitest';
import {
  detectSections,
  renderSectionsBlock,
} from '@/lib/parse/sections';

describe('detectSections', () => {
  it('returns low confidence for empty input', () => {
    const result = detectSections('');
    expect(result.sectionsFound).toBe(0);
    expect(result.confidence).toBe('low');
  });

  it('detects classic Epic H&P sections with high confidence', () => {
    const text = `CHIEF COMPLAINT: chest pain

HPI: 60 y/o M with chest pain x 2 hours

PAST MEDICAL HISTORY:
- HTN
- HLD

MEDICATIONS:
- ASA 81 mg

ALLERGIES: NKDA

VITALS:
HR 90 BP 130/80

PHYSICAL EXAM:
Cardiac: RRR

LABS:
Trop 0.05

ASSESSMENT AND PLAN:
1. ACS rule out
`;
    const result = detectSections(text);
    expect(result.confidence).toBe('high');
    expect(result.sectionsFound).toBeGreaterThanOrEqual(6);
    expect(result.sections.chief_complaint).toContain('chest pain');
    expect(result.sections.hpi).toContain('60 y/o M');
    expect(result.sections.medications).toContain('ASA');
    expect(result.sections.assessment_plan).toContain('ACS rule out');
  });

  it('returns medium confidence for partially structured notes', () => {
    const text = `HPI: pt with cough x 5 days
ALLERGIES: NKDA
MEDS: tylenol prn
no other structure here, just narrative`;
    const result = detectSections(text);
    expect(result.confidence).toBe('medium');
    expect(result.sectionsFound).toBeGreaterThanOrEqual(3);
  });

  it('returns low confidence for free-text dumps', () => {
    const text = `pt presented with weakness and confusion. wife says he stopped eating
last week. glucose was high in the field. plan is to start IVF and admit.`;
    const result = detectSections(text);
    expect(result.confidence).toBe('low');
  });

  it('does not match prose mentions of section names', () => {
    const text = 'The plan we discussed at clinic last visit was to start statins.';
    const result = detectSections(text);
    // Should not invent an assessment_plan section from this prose line
    expect(result.sections.assessment_plan ?? '').not.toContain('we discussed');
  });

  it('handles markdown-style headers (**HPI**) as well as colon-style', () => {
    const text = `**Chief Complaint**
Dyspnea

**HPI**
Patient with worsening DOE.

**MEDICATIONS**
- furosemide
`;
    const result = detectSections(text);
    expect(result.sections.chief_complaint).toBeDefined();
    expect(result.sections.hpi).toBeDefined();
    expect(result.sections.medications).toBeDefined();
  });

  it('concatenates duplicate sections with a separator', () => {
    const text = `HPI:
First encounter

HPI:
Second encounter`;
    const result = detectSections(text);
    expect(result.sections.hpi).toContain('First encounter');
    expect(result.sections.hpi).toContain('Second encounter');
    expect(result.sections.hpi).toContain('continued');
  });
});

describe('renderSectionsBlock', () => {
  it('returns empty string when no sections present', () => {
    expect(renderSectionsBlock({})).toBe('');
  });

  it('renders sections in canonical order', () => {
    const out = renderSectionsBlock({
      assessment_plan: 'Plan: admit',
      chief_complaint: 'CP',
      hpi: 'HPI text',
    });
    const cpIndex = out.indexOf('Chief Complaint');
    const hpiIndex = out.indexOf('History of Present Illness');
    const apIndex = out.indexOf('Assessment & Plan');
    expect(cpIndex).toBeLessThan(hpiIndex);
    expect(hpiIndex).toBeLessThan(apIndex);
  });

  it('skips empty section bodies', () => {
    const out = renderSectionsBlock({
      hpi: 'HPI body',
      pmh: '',
    });
    expect(out).toContain('History of Present Illness');
    expect(out).not.toContain('Past Medical History');
  });
});
