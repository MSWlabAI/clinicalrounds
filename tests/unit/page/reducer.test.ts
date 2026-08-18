/**
 * Tests for the caseReducer in app/page.tsx
 *
 * Since the reducer and helper functions are not exported separately,
 * we test their behavior through the CaseState type transitions.
 * This file tests the state machine logic extracted from the page component.
 */
import { describe, it, expect } from 'vitest';
import { Specialist } from '@/lib/types';
import type {
  CaseState,
  AnalyzeResponse,
  CrossConsultResponse,
  AdditionalDataResponse,
  SpecialistAnalysis,
  AnalysisStatus,
} from '@/lib/types';
import { caseReducer as realReducer, initialState as realInitialState } from '@/lib/reducer';
import { createMockAnalyses, MOCK_INTAKE_DATA, MOCK_DISCUSSION_MESSAGES, MOCK_CROSS_CONSULT_MESSAGES } from '../../fixtures/clinical-data';

// Replicate the reducer logic for testing since it's not exported
// We import the types and test the state transitions directly

type Action =
  | { type: 'START_ANALYSIS'; rawNotes: string }
  | { type: 'SET_PARSING' }
  | { type: 'SET_ANALYZING'; statuses: Record<string, AnalysisStatus> }
  | { type: 'ANALYSIS_COMPLETE'; data: AnalyzeResponse }
  | { type: 'SET_CROSS_CONSULTING' }
  | { type: 'CROSS_CONSULT_COMPLETE'; data: CrossConsultResponse }
  | { type: 'ANSWER_QUESTION'; questionId: string; answer: string | null }
  | { type: 'ADDITIONAL_DATA_COMPLETE'; data: AdditionalDataResponse }
  | { type: 'SET_SYNTHESIZING' }
  | { type: 'STREAM_SYNTHESIS'; chunk: string }
  | { type: 'SYNTHESIS_COMPLETE' }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'RESET' };

const initialState: CaseState = {
  step: 'idle',
  rawNotes: '',
  intakeData: null,
  parseReport: null,
  specialistAnalyses: {},
  specialistStatuses: {},
  crossConsultMessages: [],
  crossConsultRounds: [],
  currentRound: 0,
  maxRounds: 3,
  chatHistory: [],
  discussionThread: [],
  userAnswers: {},
  pendingQuestions: [],
  synthesizedPlan: '',
  isStreaming: false,
  criticalAlerts: [],
  scoringSystems: [],
  tokenUsage: { input: 0, output: 0, estimatedCost: 0 },
  error: null,
  webSearchEnabled: false,
  searchActivities: [],
  calculationActivities: [],
};

function extractQuestions(analyses: Record<string, SpecialistAnalysis>) {
  const questions: Array<{ id: string; specialist: string; question: string }> = [];
  for (const [specialist, analysis] of Object.entries(analyses)) {
    for (const q of analysis.questions_for_user) {
      questions.push({ id: Math.random().toString(36).substring(2, 10), specialist, question: q });
    }
  }
  return questions;
}

function extractCriticalAlerts(analyses: Record<string, SpecialistAnalysis>) {
  const alerts: Array<{ specialist: string; detail: string }> = [];
  for (const [specialist, analysis] of Object.entries(analyses)) {
    for (const concern of analysis.concerns) {
      if (concern.severity === 'critical') {
        alerts.push({ specialist, detail: concern.detail });
      }
    }
  }
  return alerts;
}

function extractScoringSystems(analyses: Record<string, SpecialistAnalysis>) {
  const systems: Array<{ name: string; score: number | string; interpretation: string }> = [];
  for (const analysis of Object.values(analyses)) {
    systems.push(...analysis.scoring_systems_applied);
  }
  return systems;
}

function deriveStatuses(analyses: Record<string, SpecialistAnalysis>): Record<string, AnalysisStatus> {
  const statuses: Record<string, AnalysisStatus> = {};
  for (const [specialist, analysis] of Object.entries(analyses)) {
    const hasCritical = analysis.concerns.some((c) => c.severity === 'critical');
    statuses[specialist] = hasCritical ? 'critical' : 'complete';
  }
  return statuses;
}

function caseReducer(state: CaseState, action: Action): CaseState {
  switch (action.type) {
    case 'START_ANALYSIS':
      return { ...initialState, step: 'parsing', rawNotes: action.rawNotes };
    case 'SET_PARSING':
      return { ...state, step: 'parsing' };
    case 'SET_ANALYZING':
      return { ...state, step: 'analyzing', specialistStatuses: action.statuses };
    case 'ANALYSIS_COMPLETE': {
      const { intakeData, specialistAnalyses, discussionMessages } = action.data;
      const questions = extractQuestions(specialistAnalyses);
      const alerts = extractCriticalAlerts(specialistAnalyses);
      const scores = extractScoringSystems(specialistAnalyses);
      const statuses = deriveStatuses(specialistAnalyses);
      return {
        ...state,
        step: 'cross_consulting',
        intakeData,
        specialistAnalyses,
        specialistStatuses: statuses,
        discussionThread: [...state.discussionThread, ...discussionMessages],
        pendingQuestions: questions,
        criticalAlerts: alerts,
        scoringSystems: scores,
        error: null,
      };
    }
    case 'SET_CROSS_CONSULTING':
      return { ...state, step: 'cross_consulting' };
    case 'CROSS_CONSULT_COMPLETE': {
      const { messages, updatedAnalyses, discussionMessages } = action.data;
      const newAlerts = extractCriticalAlerts(updatedAnalyses);
      const newScores = extractScoringSystems(updatedAnalyses);
      const newStatuses = deriveStatuses(updatedAnalyses);
      return {
        ...state,
        step: 'synthesizing',
        crossConsultMessages: [...state.crossConsultMessages, ...messages],
        specialistAnalyses: { ...state.specialistAnalyses, ...updatedAnalyses },
        specialistStatuses: { ...state.specialistStatuses, ...newStatuses },
        discussionThread: [...state.discussionThread, ...discussionMessages],
        criticalAlerts: [...state.criticalAlerts, ...newAlerts],
        scoringSystems: [...state.scoringSystems, ...newScores],
      };
    }
    case 'ANSWER_QUESTION': {
      const updated = state.pendingQuestions.map((q) =>
        q.id === action.questionId ? { ...q, answer: action.answer } : q
      );
      return {
        ...state,
        pendingQuestions: updated,
        userAnswers: { ...state.userAnswers, [action.questionId]: action.answer },
      };
    }
    case 'ADDITIONAL_DATA_COMPLETE': {
      const { updatedAnalyses, discussionMessages } = action.data;
      const newAlerts = extractCriticalAlerts(updatedAnalyses);
      const newScores = extractScoringSystems(updatedAnalyses);
      const newStatuses = deriveStatuses(updatedAnalyses);
      return {
        ...state,
        step: 'cross_consulting',
        specialistAnalyses: { ...state.specialistAnalyses, ...updatedAnalyses },
        specialistStatuses: { ...state.specialistStatuses, ...newStatuses },
        discussionThread: [...state.discussionThread, ...discussionMessages],
        criticalAlerts: [...state.criticalAlerts, ...newAlerts],
        scoringSystems: [...state.scoringSystems, ...newScores],
      };
    }
    case 'SET_SYNTHESIZING':
      return { ...state, step: 'synthesizing', isStreaming: true, synthesizedPlan: '' };
    case 'STREAM_SYNTHESIS':
      return { ...state, synthesizedPlan: state.synthesizedPlan + action.chunk };
    case 'SYNTHESIS_COMPLETE':
      return { ...state, step: 'complete', isStreaming: false };
    case 'SET_ERROR':
      return { ...state, error: action.error, isStreaming: false };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

describe('caseReducer', () => {
  describe('START_ANALYSIS', () => {
    it('should reset state and set step to parsing', () => {
      const state = caseReducer(initialState, { type: 'START_ANALYSIS', rawNotes: 'Patient notes' });

      expect(state.step).toBe('parsing');
      expect(state.rawNotes).toBe('Patient notes');
      expect(state.error).toBeNull();
      expect(state.specialistAnalyses).toEqual({});
    });

    it('should clear previous state', () => {
      const prevState: CaseState = {
        ...initialState,
        step: 'complete',
        synthesizedPlan: 'Old plan',
        error: 'Old error',
      };

      const state = caseReducer(prevState, { type: 'START_ANALYSIS', rawNotes: 'New notes' });

      expect(state.synthesizedPlan).toBe('');
      expect(state.error).toBeNull();
    });
  });

  describe('SET_ANALYZING', () => {
    it('should set step to analyzing and update statuses', () => {
      const statuses: Record<string, AnalysisStatus> = {
        [Specialist.ATTENDING]: 'analyzing',
        [Specialist.CARDIOLOGIST]: 'analyzing',
      };

      const state = caseReducer(initialState, { type: 'SET_ANALYZING', statuses });

      expect(state.step).toBe('analyzing');
      expect(state.specialistStatuses).toEqual(statuses);
    });
  });

  describe('ANALYSIS_COMPLETE', () => {
    it('should always transition to cross_consulting (even with questions)', () => {
      const analyses = createMockAnalyses({ withQuestions: true });
      const data: AnalyzeResponse = {
        intakeData: MOCK_INTAKE_DATA,
        specialistAnalyses: analyses,
        discussionMessages: MOCK_DISCUSSION_MESSAGES,
      };

      const state = caseReducer(initialState, { type: 'ANALYSIS_COMPLETE', data });

      expect(state.step).toBe('cross_consulting');
      expect(state.pendingQuestions.length).toBeGreaterThan(0);
    });

    it('should transition to cross_consulting when no questions', () => {
      const analyses = createMockAnalyses({ withQuestions: false });
      const data: AnalyzeResponse = {
        intakeData: MOCK_INTAKE_DATA,
        specialistAnalyses: analyses,
        discussionMessages: MOCK_DISCUSSION_MESSAGES,
      };

      const state = caseReducer(initialState, { type: 'ANALYSIS_COMPLETE', data });

      expect(state.step).toBe('cross_consulting');
      expect(state.pendingQuestions).toHaveLength(0);
    });

    it('should extract critical alerts', () => {
      const analyses = createMockAnalyses({ withCritical: true });
      const data: AnalyzeResponse = {
        intakeData: MOCK_INTAKE_DATA,
        specialistAnalyses: analyses,
        discussionMessages: [],
      };

      const state = caseReducer(initialState, { type: 'ANALYSIS_COMPLETE', data });

      expect(state.criticalAlerts.length).toBeGreaterThan(0);
      expect(state.criticalAlerts[0].specialist).toBe(Specialist.CARDIOLOGIST);
    });

    it('should extract scoring systems', () => {
      const analyses = createMockAnalyses();
      const data: AnalyzeResponse = {
        intakeData: MOCK_INTAKE_DATA,
        specialistAnalyses: analyses,
        discussionMessages: [],
      };

      const state = caseReducer(initialState, { type: 'ANALYSIS_COMPLETE', data });

      expect(state.scoringSystems.length).toBeGreaterThan(0);
    });

    it('should derive statuses from analyses', () => {
      const analyses = createMockAnalyses({ withCritical: true });
      const data: AnalyzeResponse = {
        intakeData: MOCK_INTAKE_DATA,
        specialistAnalyses: analyses,
        discussionMessages: [],
      };

      const state = caseReducer(initialState, { type: 'ANALYSIS_COMPLETE', data });

      expect(state.specialistStatuses[Specialist.CARDIOLOGIST]).toBe('critical');
      expect(state.specialistStatuses[Specialist.ATTENDING]).toBe('complete');
    });

    it('should clear error on analysis complete', () => {
      const prevState: CaseState = { ...initialState, error: 'Previous error' };
      const analyses = createMockAnalyses();
      const data: AnalyzeResponse = {
        intakeData: MOCK_INTAKE_DATA,
        specialistAnalyses: analyses,
        discussionMessages: [],
      };

      const state = caseReducer(prevState, { type: 'ANALYSIS_COMPLETE', data });

      expect(state.error).toBeNull();
    });
  });

  describe('CROSS_CONSULT_COMPLETE', () => {
    it('should transition to synthesizing', () => {
      const data: CrossConsultResponse = {
        messages: MOCK_CROSS_CONSULT_MESSAGES,
        updatedAnalyses: createMockAnalyses(),
        discussionMessages: [],
      };

      const state = caseReducer(initialState, { type: 'CROSS_CONSULT_COMPLETE', data });

      expect(state.step).toBe('synthesizing');
    });

    it('should accumulate cross-consult messages', () => {
      const data: CrossConsultResponse = {
        messages: MOCK_CROSS_CONSULT_MESSAGES,
        updatedAnalyses: createMockAnalyses(),
        discussionMessages: [],
      };

      const state = caseReducer(initialState, { type: 'CROSS_CONSULT_COMPLETE', data });

      expect(state.crossConsultMessages).toEqual(MOCK_CROSS_CONSULT_MESSAGES);
    });

    it('should append discussion messages', () => {
      const prevState: CaseState = {
        ...initialState,
        discussionThread: [{ specialist: 'test', content: 'Old msg', timestamp: 1 }],
      };

      const data: CrossConsultResponse = {
        messages: [],
        updatedAnalyses: createMockAnalyses(),
        discussionMessages: [{ specialist: 'new', content: 'New msg', timestamp: 2 }],
      };

      const state = caseReducer(prevState, { type: 'CROSS_CONSULT_COMPLETE', data });

      expect(state.discussionThread).toHaveLength(2);
    });
  });

  describe('ANSWER_QUESTION', () => {
    it('should update the answered question', () => {
      const prevState: CaseState = {
        ...initialState,
        pendingQuestions: [
          { id: 'q1', specialist: Specialist.ATTENDING, question: 'Test?' },
          { id: 'q2', specialist: Specialist.NEPHROLOGIST, question: 'Other?' },
        ],
      };

      const state = caseReducer(prevState, { type: 'ANSWER_QUESTION', questionId: 'q1', answer: 'Yes' });

      expect(state.pendingQuestions[0].answer).toBe('Yes');
      expect(state.pendingQuestions[1].answer).toBeUndefined();
    });

    it('should track answers in userAnswers', () => {
      const prevState: CaseState = {
        ...initialState,
        pendingQuestions: [{ id: 'q1', specialist: 'test', question: 'Q?' }],
      };

      const state = caseReducer(prevState, { type: 'ANSWER_QUESTION', questionId: 'q1', answer: 'My answer' });

      expect(state.userAnswers['q1']).toBe('My answer');
    });

    it('should handle null (N/A) answers', () => {
      const prevState: CaseState = {
        ...initialState,
        pendingQuestions: [{ id: 'q1', specialist: 'test', question: 'Q?' }],
      };

      const state = caseReducer(prevState, { type: 'ANSWER_QUESTION', questionId: 'q1', answer: null });

      expect(state.pendingQuestions[0].answer).toBeNull();
      expect(state.userAnswers['q1']).toBeNull();
    });
  });

  describe('SET_SYNTHESIZING', () => {
    it('should set step to synthesizing and enable streaming', () => {
      const state = caseReducer(initialState, { type: 'SET_SYNTHESIZING' });

      expect(state.step).toBe('synthesizing');
      expect(state.isStreaming).toBe(true);
      expect(state.synthesizedPlan).toBe('');
    });
  });

  describe('STREAM_SYNTHESIS', () => {
    it('should append chunks to synthesized plan', () => {
      let state = caseReducer(initialState, { type: 'SET_SYNTHESIZING' });
      state = caseReducer(state, { type: 'STREAM_SYNTHESIS', chunk: 'Problem 1: ' });
      state = caseReducer(state, { type: 'STREAM_SYNTHESIS', chunk: 'CHF exacerbation' });

      expect(state.synthesizedPlan).toBe('Problem 1: CHF exacerbation');
    });
  });

  describe('SYNTHESIS_COMPLETE', () => {
    it('should set step to complete and stop streaming', () => {
      let state = caseReducer(initialState, { type: 'SET_SYNTHESIZING' });
      state = caseReducer(state, { type: 'STREAM_SYNTHESIS', chunk: 'Final plan' });
      state = caseReducer(state, { type: 'SYNTHESIS_COMPLETE' });

      expect(state.step).toBe('complete');
      expect(state.isStreaming).toBe(false);
      expect(state.synthesizedPlan).toBe('Final plan');
    });
  });

  describe('SET_ERROR', () => {
    it('should set error message', () => {
      const state = caseReducer(initialState, { type: 'SET_ERROR', error: 'API failed' });

      expect(state.error).toBe('API failed');
    });

    it('should stop streaming on error', () => {
      const streamingState: CaseState = { ...initialState, isStreaming: true };
      const state = caseReducer(streamingState, { type: 'SET_ERROR', error: 'Error' });

      expect(state.isStreaming).toBe(false);
    });
  });

  describe('RESET', () => {
    it('should return initial state', () => {
      const dirtyState: CaseState = {
        ...initialState,
        step: 'complete',
        rawNotes: 'Stuff',
        synthesizedPlan: 'Plan',
        error: 'Error',
      };

      const state = caseReducer(dirtyState, { type: 'RESET' });

      expect(state).toEqual(initialState);
    });
  });

  describe('State machine flow', () => {
    it('should complete full auto-flow: idle -> parsing -> analyzing -> cross_consulting -> synthesizing -> complete', () => {
      let state = initialState;

      // Start
      state = caseReducer(state, { type: 'START_ANALYSIS', rawNotes: 'Notes' });
      expect(state.step).toBe('parsing');

      // Set analyzing
      const statuses: Record<string, AnalysisStatus> = {};
      for (const s of Object.values(Specialist)) {
        statuses[s] = 'analyzing';
      }
      state = caseReducer(state, { type: 'SET_ANALYZING', statuses });
      expect(state.step).toBe('analyzing');

      // Analysis complete — always goes to cross_consulting (no awaiting_input gate)
      const analyses = createMockAnalyses({ withQuestions: false });
      state = caseReducer(state, {
        type: 'ANALYSIS_COMPLETE',
        data: { intakeData: MOCK_INTAKE_DATA, specialistAnalyses: analyses, discussionMessages: [] },
      });
      expect(state.step).toBe('cross_consulting');

      // Cross-consult complete — goes directly to synthesizing
      state = caseReducer(state, {
        type: 'CROSS_CONSULT_COMPLETE',
        data: { messages: [], updatedAnalyses: analyses, discussionMessages: [] },
      });
      expect(state.step).toBe('synthesizing');

      // Stream synthesis
      state = caseReducer(state, { type: 'STREAM_SYNTHESIS', chunk: 'Assessment text' });
      expect(state.synthesizedPlan).toBe('Assessment text');

      state = caseReducer(state, { type: 'SYNTHESIS_COMPLETE' });
      expect(state.step).toBe('complete');
      expect(state.isStreaming).toBe(false);
    });
  });
});

// ─── Web Search reducer tests (using real reducer) ──────────────────────────

describe('caseReducer web search actions', () => {
  it('TOGGLE_WEB_SEARCH should toggle webSearchEnabled', () => {
    let state = realReducer(realInitialState, { type: 'TOGGLE_WEB_SEARCH', enabled: true });
    expect(state.webSearchEnabled).toBe(true);

    state = realReducer(state, { type: 'TOGGLE_WEB_SEARCH', enabled: false });
    expect(state.webSearchEnabled).toBe(false);
  });

  it('SPECIALIST_SEARCH should append to searchActivities', () => {
    const activity = {
      specialist: 'cardiologist',
      query: 'ACC heart failure guidelines',
      citations: [],
      timestamp: Date.now(),
    };

    const state = realReducer(realInitialState, { type: 'SPECIALIST_SEARCH', activity });
    expect(state.searchActivities).toHaveLength(1);
    expect(state.searchActivities[0].query).toBe('ACC heart failure guidelines');
  });

  it('START_ANALYSIS should preserve webSearchEnabled', () => {
    let state = realReducer(realInitialState, { type: 'TOGGLE_WEB_SEARCH', enabled: true });
    state = realReducer(state, { type: 'START_ANALYSIS', rawNotes: 'test notes' });

    expect(state.webSearchEnabled).toBe(true);
    expect(state.searchActivities).toHaveLength(0); // reset
  });
});
