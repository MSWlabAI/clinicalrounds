import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MOCK_INTAKE_DATA,
  MOCK_CLAUDE_TEXT_RESPONSE,
  MOCK_CLAUDE_MALFORMED_RESPONSE,
  MOCK_CLAUDE_EMPTY_RESPONSE,
  createMockAnalyses,
  MOCK_CROSS_CONSULT_MESSAGES,
} from '../../fixtures/clinical-data';
import { Specialist } from '@/lib/types';

// Mock the Anthropic SDK before importing orchestrator
const { mockCreate, mockStream } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockStream: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = function() {
    return {
      messages: {
        create: mockCreate,
        stream: mockStream,
      },
    };
  };
  return { default: MockAnthropic };
});

// Import after mocking
import { runIntake, runSpecialists, runSpecialistsStreaming, runCrossConsult, runAdditionalData, runSynthesis } from '@/lib/orchestrator';

describe('orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Keep the ParseStage LLM structurer disabled so existing tests
    // continue to assert on the single intake LLM call. Tests that want
    // to exercise the structurer set ANTHROPIC_API_KEY explicitly.
    delete process.env.ANTHROPIC_API_KEY;
  });

  describe('runIntake', () => {
    it('should parse raw text into IntakeData', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{
          type: 'text',
          text: JSON.stringify({
            demographics: { age: 68, sex: 'M' },
            chief_complaint: 'Dyspnea',
            hpi: 'Test HPI',
            past_medical_history: ['CHF'],
            medications: [],
            allergies: [],
            vitals: { hr: 100 },
            labs: [],
            imaging: [],
            physical_exam: 'Normal',
            procedures_consults: [],
            missing_data: [],
            raw_text: '',
          }),
        }],
      });

      const { intakeData } = await runIntake('Test clinical notes');

      expect(intakeData).toBeDefined();
      expect(intakeData.demographics.age).toBe(68);
      expect(intakeData.chief_complaint).toBe('Dyspnea');
      expect(intakeData.raw_text).toBe('Test clinical notes');
    });

    it('should use Sonnet model for intake parsing', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({ ...MOCK_INTAKE_DATA, raw_text: '' }) }],
      });

      await runIntake('Notes');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-5-20250929',
        })
      );
    });

    it('should pass the raw text as user message', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({ ...MOCK_INTAKE_DATA, raw_text: '' }) }],
      });

      await runIntake('My test notes here');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: 'My test notes here' }],
        })
      );
    });

    it('should throw when response has no JSON', async () => {
      mockCreate.mockResolvedValueOnce(MOCK_CLAUDE_MALFORMED_RESPONSE);

      await expect(runIntake('Notes')).rejects.toThrow('Failed to parse clinical notes');
    });

    it('should throw when response content is not text', async () => {
      mockCreate.mockResolvedValueOnce(MOCK_CLAUDE_EMPTY_RESPONSE);

      await expect(runIntake('Notes')).rejects.toThrow('Failed to parse clinical notes');
    });

    it('should extract JSON from text with surrounding prose', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{
          type: 'text',
          text: `Here is the parsed data:\n\n${JSON.stringify({ ...MOCK_INTAKE_DATA, raw_text: '' })}\n\nLet me know if you need more.`,
        }],
      });

      const { intakeData } = await runIntake('Notes');
      expect(intakeData.demographics.age).toBe(68);
    });

    it('should overwrite raw_text with original input', async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{
          type: 'text',
          text: JSON.stringify({ ...MOCK_INTAKE_DATA, raw_text: 'wrong text' }),
        }],
      });

      const { intakeData } = await runIntake('original notes');
      expect(intakeData.raw_text).toBe('original notes');
    });
  });

  describe('runSpecialists', () => {
    it('should run all specialists in parallel', async () => {
      const specialistCount = Object.values(Specialist).length;

      mockCreate.mockResolvedValue(MOCK_CLAUDE_TEXT_RESPONSE);

      const results = await runSpecialists(MOCK_INTAKE_DATA);

      expect(mockCreate).toHaveBeenCalledTimes(specialistCount);
      expect(Object.keys(results)).toHaveLength(specialistCount);
    });

    it('should key results by specialist name', async () => {
      mockCreate.mockResolvedValue(MOCK_CLAUDE_TEXT_RESPONSE);

      const results = await runSpecialists(MOCK_INTAKE_DATA);

      for (const s of Object.values(Specialist)) {
        expect(results[s]).toBeDefined();
        expect(results[s].specialist).toBe(s);
      }
    });

    it('should use Opus model for attending', async () => {
      mockCreate.mockResolvedValue(MOCK_CLAUDE_TEXT_RESPONSE);

      await runSpecialists(MOCK_INTAKE_DATA);

      const hasOpusCall = mockCreate.mock.calls.some(
        (call: unknown[]) => (call[0] as { model: string }).model === 'claude-opus-4-6'
      );
      expect(hasOpusCall).toBe(true);
    });

    it('should use Sonnet model for non-attending specialists', async () => {
      mockCreate.mockResolvedValue(MOCK_CLAUDE_TEXT_RESPONSE);

      await runSpecialists(MOCK_INTAKE_DATA);

      const sonnetCalls = mockCreate.mock.calls.filter(
        (call: unknown[]) => (call[0] as { model: string }).model === 'claude-sonnet-4-5-20250929'
      );
      expect(sonnetCalls.length).toBeGreaterThan(5);
    });

    it('should include patient data in each specialist message', async () => {
      mockCreate.mockResolvedValue(MOCK_CLAUDE_TEXT_RESPONSE);

      await runSpecialists(MOCK_INTAKE_DATA);

      for (const call of mockCreate.mock.calls) {
        const msg = (call[0] as { messages: Array<{ content: string }> }).messages[0].content;
        expect(msg).toContain('Analyze the following patient data');
      }
    });

    it('should provide fallback analysis when a specialist returns malformed JSON', async () => {
      mockCreate.mockResolvedValueOnce(MOCK_CLAUDE_MALFORMED_RESPONSE);
      mockCreate.mockResolvedValue(MOCK_CLAUDE_TEXT_RESPONSE);

      const results = await runSpecialists(MOCK_INTAKE_DATA);
      // All specialists should still be present (fallback for the failed one)
      const specialistCount = Object.values(Specialist).length;
      expect(Object.keys(results)).toHaveLength(specialistCount);
      // The failed specialist gets a fallback with error message in findings
      const failedSpecialist = Object.values(results).find(
        (a) => a.findings[0]?.includes('unavailable')
      );
      expect(failedSpecialist).toBeDefined();
    });
  });

  describe('runCrossConsult', () => {
    it('should return empty array when no cross-consults requested', async () => {
      const analyses = createMockAnalyses({ withCrossConsults: false });
      const result = await runCrossConsult(analyses, MOCK_INTAKE_DATA);

      expect(result).toEqual([]);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('should process cross-consult requests in parallel', async () => {
      const analyses = createMockAnalyses({ withCrossConsults: true });

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'I agree, consider dose reduction.' }],
      });

      const result = await runCrossConsult(analyses, MOCK_INTAKE_DATA);

      expect(mockCreate).toHaveBeenCalled();
      expect(result.length).toBeGreaterThan(0);
    });

    it('should include response in cross-consult messages', async () => {
      const analyses = createMockAnalyses({ withCrossConsults: true });

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Response text.' }],
      });

      const result = await runCrossConsult(analyses, MOCK_INTAKE_DATA);

      for (const msg of result) {
        expect(msg.from).toBeDefined();
        expect(msg.to).toBeDefined();
        expect(msg.response).toBeDefined();
      }
    });

    it('should filter out null results for missing target specialists', async () => {
      const analyses: Record<string, any> = {
        [Specialist.NEPHROLOGIST]: {
          ...createMockAnalyses({ withCrossConsults: true })[Specialist.NEPHROLOGIST],
          cross_consults: [{ to: 'nonexistent_specialist', question: 'test?' }],
        },
      };

      const result = await runCrossConsult(analyses, MOCK_INTAKE_DATA);
      expect(result.every((m) => m !== null)).toBe(true);
    });

    it('should use Sonnet for cross-consult responses', async () => {
      const analyses = createMockAnalyses({ withCrossConsults: true });

      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'Response.' }],
      });

      await runCrossConsult(analyses, MOCK_INTAKE_DATA);

      for (const call of mockCreate.mock.calls) {
        expect((call[0] as { model: string }).model).toBe('claude-sonnet-4-5-20250929');
      }
    });
  });

  describe('runAdditionalData', () => {
    it('should return previous analyses when no answers provided', async () => {
      const analyses = createMockAnalyses();
      const result = await runAdditionalData(
        { q1: null, q2: null },
        analyses,
        MOCK_INTAKE_DATA
      );

      expect(result).toBe(analyses);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('should re-run all specialists with additional context', async () => {
      mockCreate.mockResolvedValue(MOCK_CLAUDE_TEXT_RESPONSE);

      const analyses = createMockAnalyses();
      const answers = { 'Recent med changes?': 'Yes, stopped lisinopril 2 days ago' };

      const result = await runAdditionalData(answers, analyses, MOCK_INTAKE_DATA);

      const specialistCount = Object.values(Specialist).length;
      expect(mockCreate).toHaveBeenCalledTimes(specialistCount);
      expect(Object.keys(result)).toHaveLength(specialistCount);
    });

    it('should include answers in the prompt', async () => {
      mockCreate.mockResolvedValue(MOCK_CLAUDE_TEXT_RESPONSE);

      const analyses = createMockAnalyses();
      const answers = { 'What was baseline Cr?': '1.5' };

      await runAdditionalData(answers, analyses, MOCK_INTAKE_DATA);

      const firstCall = mockCreate.mock.calls[0];
      const msg = (firstCall[0] as { messages: Array<{ content: string }> }).messages[0].content;
      expect(msg).toContain('ADDITIONAL DATA PROVIDED');
      expect(msg).toContain('What was baseline Cr?');
      expect(msg).toContain('1.5');
    });

    it('should fall back to previous analysis on malformed response', async () => {
      const analyses = createMockAnalyses();

      mockCreate.mockResolvedValue(MOCK_CLAUDE_MALFORMED_RESPONSE);

      const answers = { 'Test question?': 'Test answer' };
      const result = await runAdditionalData(answers, analyses, MOCK_INTAKE_DATA);

      expect(Object.keys(result).length).toBeGreaterThan(0);
    });
  });

  describe('runSynthesis', () => {
    it('should yield text chunks from the stream', async () => {
      const chunks = ['Problem 1:', ' CHF', ' exacerbation'];
      let index = 0;

      const mockAsyncIterable = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (index < chunks.length) {
                return {
                  value: {
                    type: 'content_block_delta',
                    delta: { type: 'text_delta', text: chunks[index++] },
                  },
                  done: false,
                };
              }
              return { value: undefined, done: true };
            },
          };
        },
      };

      mockStream.mockReturnValueOnce(mockAsyncIterable);

      const analyses = createMockAnalyses();
      const collected: string[] = [];

      for await (const chunk of runSynthesis(analyses, [], MOCK_INTAKE_DATA)) {
        collected.push(chunk);
      }

      expect(collected).toEqual(chunks);
    });

    it('should use Opus model for synthesis', async () => {
      const mockAsyncIterable = {
        [Symbol.asyncIterator]() {
          return { async next() { return { value: undefined, done: true }; } };
        },
      };

      mockStream.mockReturnValueOnce(mockAsyncIterable);

      const analyses = createMockAnalyses();
      for await (const _ of runSynthesis(analyses, [], MOCK_INTAKE_DATA)) {
        // consume
      }

      expect(mockStream).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-opus-4-6' })
      );
    });

    it('should include all specialist analyses in the synthesis prompt', async () => {
      const mockAsyncIterable = {
        [Symbol.asyncIterator]() {
          return { async next() { return { value: undefined, done: true }; } };
        },
      };

      mockStream.mockReturnValueOnce(mockAsyncIterable);

      const analyses = createMockAnalyses();
      for await (const _ of runSynthesis(analyses, MOCK_CROSS_CONSULT_MESSAGES, MOCK_INTAKE_DATA)) {
        // consume
      }

      const callArgs = mockStream.mock.calls[0][0];
      const msg = callArgs.messages[0].content;
      expect(msg).toContain('SPECIALIST ANALYSES');
      expect(msg).toContain('CROSS-CONSULTATION NOTES');
      expect(msg).toContain('PATIENT DATA');
    });

    it('should skip non-text-delta events', async () => {
      let index = 0;
      const events = [
        { type: 'message_start', delta: {} },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_stop', delta: {} },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ' World' } },
        { type: 'message_stop', delta: {} },
      ];

      const mockAsyncIterable = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (index < events.length) {
                return { value: events[index++], done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
      };

      mockStream.mockReturnValueOnce(mockAsyncIterable);

      const collected: string[] = [];
      for await (const chunk of runSynthesis(createMockAnalyses(), [], MOCK_INTAKE_DATA)) {
        collected.push(chunk);
      }

      expect(collected).toEqual(['Hello', ' World']);
    });
  });

  describe('web search integration', () => {
    it('should pass web_search tool when webSearchEnabled is true', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(MOCK_CLAUDE_TEXT_RESPONSE.content[0].type === 'text' ? JSON.parse(MOCK_CLAUDE_TEXT_RESPONSE.content[0].text) : {}) }],
      });

      const onResult = vi.fn();
      const onError = vi.fn();

      await runSpecialistsStreaming(MOCK_INTAKE_DATA, onResult, onError, { webSearchEnabled: true });

      for (const call of mockCreate.mock.calls) {
        const params = call[0] as { tools?: unknown[] };
        expect(params.tools).toBeDefined();
        expect(params.tools).toHaveLength(1);
        expect((params.tools![0] as { type: string }).type).toBe('web_search_20250305');
      }
    });

    it('should NOT pass tools when webSearchEnabled is false', async () => {
      mockCreate.mockResolvedValue(MOCK_CLAUDE_TEXT_RESPONSE);

      const onResult = vi.fn();
      const onError = vi.fn();

      await runSpecialistsStreaming(MOCK_INTAKE_DATA, onResult, onError, { webSearchEnabled: false });

      for (const call of mockCreate.mock.calls) {
        const params = call[0] as { tools?: unknown[] };
        expect(params.tools).toBeUndefined();
      }
    });

    it('should NOT pass tools when no options provided', async () => {
      mockCreate.mockResolvedValue(MOCK_CLAUDE_TEXT_RESPONSE);

      const onResult = vi.fn();
      const onError = vi.fn();

      await runSpecialistsStreaming(MOCK_INTAKE_DATA, onResult, onError);

      for (const call of mockCreate.mock.calls) {
        const params = call[0] as { tools?: unknown[] };
        expect(params.tools).toBeUndefined();
      }
    });

    it('should extract citations from web_search_tool_result blocks', async () => {
      mockCreate.mockResolvedValue({
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_01',
            name: 'web_search',
            input: { query: 'ACC heart failure guidelines 2024' },
          },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_01',
            content: [
              {
                type: 'web_search_result',
                url: 'https://acc.org/guidelines/hf-2024',
                title: 'ACC/AHA HF Guidelines 2024',
                page_age: '3 months ago',
              },
              {
                type: 'web_search_result',
                url: 'https://pubmed.ncbi.nlm.nih.gov/12345',
                title: 'SGLT2i in HFpEF Meta-Analysis',
              },
            ],
          },
          {
            type: 'text',
            text: JSON.stringify({
              findings: ['Heart failure with reduced EF'],
              concerns: [],
              recommendations: [],
              questions_for_user: [],
              questions_for_team: [],
              cross_consults: [],
              scoring_systems_applied: [],
            }),
          },
        ],
      });

      const onResult = vi.fn();
      const onError = vi.fn();
      const onSearch = vi.fn();

      await runSpecialistsStreaming(MOCK_INTAKE_DATA, onResult, onError, {
        webSearchEnabled: true,
        onSearch,
      });

      // At least one specialist should have citations
      const callsWithCitations = onResult.mock.calls.filter(
        (call) => call[1].web_search_citations && call[1].web_search_citations.length > 0
      );
      expect(callsWithCitations.length).toBeGreaterThan(0);

      const citedAnalysis = callsWithCitations[0][1];
      expect(citedAnalysis.web_search_citations).toHaveLength(2);
      expect(citedAnalysis.web_search_citations[0].title).toBe('ACC/AHA HF Guidelines 2024');
      expect(citedAnalysis.web_search_citations[0].url).toBe('https://acc.org/guidelines/hf-2024');

      // onSearch should have been called with the query
      expect(onSearch).toHaveBeenCalled();
    });
  });
});
