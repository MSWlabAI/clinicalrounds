/**
 * E2E Test: Full Analysis Pipeline
 *
 * Tests the complete flow: raw notes → intake → specialists → cross-consult → synthesis
 * using fake clinical cases with mocked Anthropic SDK.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Specialist } from '@/lib/types';
import {
  CHF_RAW_NOTES,
  CHF_INTAKE_RESPONSE,
  buildSpecialistResponse,
} from '../fixtures/fake-cases';
import {
  MOCK_INTAKE_DATA,
  createMockAnalyses,
} from '../fixtures/clinical-data';

// ─── Mock Anthropic SDK ─────────────────────────────────────────────────────

const { mockCreate, mockStream } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockStream: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = function () {
    return {
      messages: {
        create: mockCreate,
        stream: mockStream,
      },
    };
  };
  return { default: MockAnthropic };
});

// ─── Mock orchestrator for route-level tests ────────────────────────────────

vi.mock('@/lib/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator')>();
  return {
    ...actual,
    runIntake: vi.fn(),
    runSpecialistsStreaming: vi.fn(),
    runCrossConsultStreaming: vi.fn(),
    runCrossConsult: vi.fn(),
    runMultiRoundCrossConsult: vi.fn(),
    runSynthesis: vi.fn(),
  };
});

import {
  runIntake,
  runSpecialistsStreaming,
  runCrossConsultStreaming,
  runSynthesis,
} from '@/lib/orchestrator';
import { POST as analyzePost } from '@/app/api/analyze/route';
import { POST as crossConsultPost } from '@/app/api/cross-consult/route';
import { POST as synthesizePost } from '@/app/api/synthesize/route';

// ─── Helpers ────────────────────────────────────────────────────────────────

async function readSSEEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        try { events.push(JSON.parse(trimmed.slice(6))); } catch { /* skip */ }
      }
    }
  }
  if (buffer.trim().startsWith('data: ')) {
    try { events.push(JSON.parse(buffer.trim().slice(6))); } catch { /* skip */ }
  }
  return events;
}

function makeAnalyzeRequest(rawNotes: string) {
  return new Request('http://localhost/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawNotes }),
  }) as any;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('E2E: Full Analysis Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('CHF Case — Complete Pipeline', () => {
    it('should process CHF case through intake → specialists → cross-consult → done', async () => {
      const mockAnalyses = createMockAnalyses({ withCrossConsults: true });

      // Setup mock: intake returns structured data
      vi.mocked(runIntake).mockResolvedValueOnce(MOCK_INTAKE_DATA);

      // Setup mock: specialists stream results
      vi.mocked(runSpecialistsStreaming).mockImplementationOnce(
        async (intakeData, onResult, onError) => {
          for (const [specialist, analysis] of Object.entries(mockAnalyses)) {
            onResult(specialist as Specialist, analysis);
          }
          return mockAnalyses;
        }
      );

      // Step 1: Analyze
      const analyzeRes = await analyzePost(makeAnalyzeRequest(CHF_RAW_NOTES));
      expect(analyzeRes.headers.get('Content-Type')).toBe('text/event-stream');

      const events = await readSSEEvents(analyzeRes);

      // Verify intake was parsed
      const intakeEvent = events.find((e) => e.type === 'intake_complete');
      expect(intakeEvent).toBeDefined();
      expect(intakeEvent!.intakeData).toBeDefined();

      // Verify all specialists completed
      const specialistEvents = events.filter((e) => e.type === 'specialist_complete');
      expect(specialistEvents.length).toBe(Object.values(Specialist).length);

      // Verify each specialist has required fields
      for (const event of specialistEvents) {
        const analysis = event.analysis as any;
        expect(analysis.findings).toBeDefined();
        expect(analysis.concerns).toBeDefined();
        expect(analysis.recommendations).toBeDefined();
      }

      // Verify analyze_done was emitted
      const doneEvent = events.find((e) => e.type === 'analyze_done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent!.totalSpecialists).toBe(Object.values(Specialist).length);
    });

    it('should handle specialist failures gracefully in the pipeline', async () => {
      vi.mocked(runIntake).mockResolvedValueOnce(MOCK_INTAKE_DATA);

      // Some specialists fail, some succeed
      vi.mocked(runSpecialistsStreaming).mockImplementationOnce(
        async (intakeData, onResult, onError) => {
          const analyses = createMockAnalyses();
          let count = 0;
          for (const [specialist, analysis] of Object.entries(analyses)) {
            if (count < 2) {
              onError(specialist as Specialist, 'API timeout');
            } else {
              onResult(specialist as Specialist, analysis);
            }
            count++;
          }
          return analyses;
        }
      );

      const res = await analyzePost(makeAnalyzeRequest(CHF_RAW_NOTES));
      const events = await readSSEEvents(res);

      // Should have both success and error events
      const successEvents = events.filter((e) => e.type === 'specialist_complete');
      const errorEvents = events.filter((e) => e.type === 'specialist_error');
      expect(successEvents.length).toBeGreaterThan(0);
      expect(errorEvents.length).toBe(2);

      // Pipeline should still complete
      const doneEvent = events.find((e) => e.type === 'analyze_done');
      expect(doneEvent).toBeDefined();
    });

    it('should propagate intake parsing errors', async () => {
      vi.mocked(runIntake).mockRejectedValueOnce(new Error('Failed to parse intake data'));

      const res = await analyzePost(makeAnalyzeRequest('garbage input'));
      const events = await readSSEEvents(res);

      const errorEvent = events.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.error).toContain('Failed to parse');
    });
  });

  describe('Cross-Consult Phase', () => {
    it('should process cross-consult exchanges in streaming mode', async () => {
      const analyses = createMockAnalyses({ withCrossConsults: true });

      vi.mocked(runCrossConsultStreaming).mockImplementationOnce(
        async (analysesArg, intakeData, onMessage) => {
          const msg = {
            from: Specialist.NEPHROLOGIST,
            to: Specialist.CARDIOLOGIST,
            message: 'Should we hold ACEi given rising Cr?',
            response: 'Reduce dose rather than holding.',
          };
          onMessage(msg);
          return [msg];
        }
      );

      const { NextRequest } = await import('next/server');
      const req = new NextRequest('http://localhost/api/cross-consult?stream=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analyses, intakeData: MOCK_INTAKE_DATA }),
      });

      const res = await crossConsultPost(req);
      const events = await readSSEEvents(res);

      const ccEvent = events.find((e) => e.type === 'cross_consult_message');
      expect(ccEvent).toBeDefined();
      const msg = ccEvent!.message as any;
      expect(msg.from).toBe(Specialist.NEPHROLOGIST);
      expect(msg.to).toBe(Specialist.CARDIOLOGIST);
      expect(msg.response).toContain('Reduce dose');

      const doneEvent = events.find((e) => e.type === 'cross_consult_done');
      expect(doneEvent).toBeDefined();
    });
  });

  describe('Synthesis Phase', () => {
    it('should stream synthesis text', async () => {
      const chunks = ['Problem 1:', ' CHF Exacerbation\n', '- IV diuresis'];

      vi.mocked(runSynthesis).mockReturnValueOnce(
        (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })()
      );

      const req = new Request('http://localhost/api/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analyses: createMockAnalyses(),
          crossConsults: [],
          intakeData: MOCK_INTAKE_DATA,
        }),
      });

      const res = await synthesizePost(req);
      expect(res.headers.get('Content-Type')).toContain('text/plain');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
      }

      expect(fullText).toContain('Problem 1:');
      expect(fullText).toContain('CHF Exacerbation');
      expect(fullText).toContain('IV diuresis');
    });
  });
});
