import { generateId } from '@/lib/utils';
import type {
  CaseState,
  AnalyzeResponse,
  CrossConsultResponse,
  AdditionalDataResponse,
  SpecialistAnalysis,
  SpecialistSearchActivity,
  SpecialistCalculationActivity,
  UserQuestion,
  ScoringSystem,
  AnalysisStatus,
  DiscussionMessage,
  CrossConsultMessage,
  CrossConsultMessageV2,
  CrossConsultRound,
  IntakeData,
  SpecialistChatMessage,
  DiscussionPauseState,
  UserSteeringAction,
  ParseReport,
} from '@/lib/types';
import { Specialist } from '@/lib/types';

// ─── Helper Functions ─────────────────────────────────────────────────────────

/** Extract ONLY questions_for_user — rare, truly-missing-data questions for the clinician. */
export function extractUserQuestions(analyses: Record<string, SpecialistAnalysis>): UserQuestion[] {
  const questions: UserQuestion[] = [];
  for (const [specialist, analysis] of Object.entries(analyses)) {
    const qs = Array.isArray(analysis.questions_for_user) ? analysis.questions_for_user : [];
    for (const q of qs) {
      if (typeof q === 'string' && q.trim()) {
        questions.push({
          id: generateId(),
          specialist,
          question: q,
        });
      }
    }
  }
  return questions;
}

export function extractCriticalAlerts(analyses: Record<string, SpecialistAnalysis>): Array<{ specialist: string; detail: string }> {
  const alerts: Array<{ specialist: string; detail: string }> = [];
  for (const [specialist, analysis] of Object.entries(analyses)) {
    const concerns = Array.isArray(analysis.concerns) ? analysis.concerns : [];
    for (const concern of concerns) {
      if (concern.severity === 'critical') {
        alerts.push({ specialist, detail: concern.detail });
      }
    }
    const critActions = (analysis as unknown as Record<string, unknown>).critical_actions;
    if (Array.isArray(critActions)) {
      for (const action of critActions) {
        if (typeof action === 'string') {
          alerts.push({ specialist, detail: action });
        }
      }
    }
  }
  return alerts;
}

export function extractScoringSystems(analyses: Record<string, SpecialistAnalysis>): ScoringSystem[] {
  const systems: ScoringSystem[] = [];
  for (const analysis of Object.values(analyses)) {
    const applied = Array.isArray(analysis.scoring_systems_applied) ? analysis.scoring_systems_applied : [];
    systems.push(...applied);
  }
  return systems;
}

export function deriveStatuses(analyses: Record<string, SpecialistAnalysis>): Record<string, AnalysisStatus> {
  const statuses: Record<string, AnalysisStatus> = {};
  for (const [specialist, analysis] of Object.entries(analyses)) {
    const concerns = Array.isArray(analysis.concerns) ? analysis.concerns : [];
    const hasCritical = concerns.some((c) => c.severity === 'critical');
    statuses[specialist] = hasCritical ? 'critical' : 'complete';
  }
  return statuses;
}

export function estimateTotalExchanges(analyses: Record<string, SpecialistAnalysis>): number {
  let count = 0;
  for (const a of Object.values(analyses)) {
    count += a.cross_consults.length + a.questions_for_team.length;
  }
  return Math.max(count, 1);
}

/** Derive flat crossConsultMessages from crossConsultRounds for backward compatibility. */
function flattenRounds(rounds: CrossConsultRound[]): CrossConsultMessage[] {
  const messages: CrossConsultMessage[] = [];
  for (const round of rounds) {
    messages.push(...round.messages);
  }
  return messages;
}

// ─── Action Types ─────────────────────────────────────────────────────────────

export type Action =
  // Existing actions
  | { type: 'START_ANALYSIS'; rawNotes: string }
  | { type: 'SET_PARSING' }
  | { type: 'SET_ANALYZING'; statuses: Record<string, AnalysisStatus> }
  | { type: 'INTAKE_COMPLETE'; intakeData: IntakeData }
  | { type: 'PARSE_COMPLETE'; parseReport: ParseReport }
  | { type: 'SPECIALIST_COMPLETE'; specialist: string; analysis: SpecialistAnalysis; discussionMessage: DiscussionMessage }
  | { type: 'SPECIALIST_ERROR'; specialist: string; error: string }
  | { type: 'ANALYZE_DONE' }
  | { type: 'ANALYSIS_COMPLETE'; data: AnalyzeResponse }
  | { type: 'SET_CROSS_CONSULTING' }
  | { type: 'CROSS_CONSULT_MESSAGE'; message: CrossConsultMessage; discussionMessage: DiscussionMessage }
  | { type: 'CROSS_CONSULT_DONE' }
  | { type: 'CROSS_CONSULT_COMPLETE'; data: CrossConsultResponse }
  | { type: 'ANSWER_QUESTION'; questionId: string; answer: string | null }
  | { type: 'ADDITIONAL_DATA_COMPLETE'; data: AdditionalDataResponse }
  | { type: 'SET_SYNTHESIZING' }
  | { type: 'STREAM_SYNTHESIS'; chunk: string }
  | { type: 'SYNTHESIS_COMPLETE' }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'RESET' }
  // New multi-round cross-consult actions
  | { type: 'CROSS_CONSULT_ROUND_START'; round: number }
  | { type: 'CROSS_CONSULT_ROUND_MESSAGE'; round: number; message: CrossConsultMessageV2; discussionMessage: DiscussionMessage }
  | { type: 'CROSS_CONSULT_ROUND_DONE'; round: number }
  | { type: 'ALL_ROUNDS_COMPLETE'; totalRounds: number }
  // Discussion pause / steering actions
  | { type: 'DISCUSSION_PAUSED'; pauseState: DiscussionPauseState }
  | { type: 'USER_STEERING_ACTION'; action: UserSteeringAction }
  // Append notes actions
  | { type: 'APPEND_NOTES'; additionalNotes: string }
  | { type: 'INCREMENTAL_INTAKE_COMPLETE'; intakeData: IntakeData; updatedAnalyses: Record<string, SpecialistAnalysis>; discussionMessages: DiscussionMessage[] }
  // Chat actions
  | { type: 'CHAT_MESSAGE_SENT'; message: SpecialistChatMessage }
  | { type: 'CHAT_RESPONSE_RECEIVED'; message: SpecialistChatMessage; triggeredDiscussions?: CrossConsultMessage[] }
  | { type: 'SET_CHATTING' }
  // Web search actions
  | { type: 'TOGGLE_WEB_SEARCH'; enabled: boolean }
  | { type: 'SPECIALIST_SEARCH'; activity: SpecialistSearchActivity }
  | { type: 'SPECIALIST_CALCULATION'; activity: SpecialistCalculationActivity }
  // Triage actions
  | { type: 'TRIAGE_COMPLETE'; selectedSpecialists: string[]; skippedSpecialists: string[]; reasoning: string };

// ─── Initial State ────────────────────────────────────────────────────────────

export const initialState: CaseState = {
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

// ─── Reducer ──────────────────────────────────────────────────────────────────

export function caseReducer(state: CaseState, action: Action): CaseState {
  switch (action.type) {
    // ── Existing actions (unchanged behavior) ─────────────────────────────

    case 'START_ANALYSIS':
      return {
        ...initialState,
        step: 'parsing',
        rawNotes: action.rawNotes,
        webSearchEnabled: state.webSearchEnabled,
        calculationActivities: [],
      };

    case 'SET_PARSING':
      return { ...state, step: 'parsing' };

    case 'SET_ANALYZING':
      return { ...state, step: 'analyzing', specialistStatuses: action.statuses };

    case 'INTAKE_COMPLETE':
      return { ...state, intakeData: action.intakeData };

    case 'PARSE_COMPLETE':
      return { ...state, parseReport: action.parseReport };

    case 'TRIAGE_COMPLETE': {
      // Update specialist statuses: selected ones are 'analyzing', skipped ones are removed
      const newStatuses: Record<string, AnalysisStatus> = {};
      for (const s of action.selectedSpecialists) {
        newStatuses[s] = 'analyzing';
      }
      return { ...state, specialistStatuses: newStatuses };
    }

    case 'SPECIALIST_COMPLETE': {
      const analysis = action.analysis;
      const concerns = Array.isArray(analysis.concerns) ? analysis.concerns : [];
      const hasCritical = concerns.some((c) => c.severity === 'critical');
      const newAlerts: Array<{ specialist: string; detail: string }> = [];
      for (const concern of concerns) {
        if (concern.severity === 'critical') {
          newAlerts.push({ specialist: action.specialist, detail: concern.detail });
        }
      }
      const critActions = (analysis as unknown as Record<string, unknown>).critical_actions;
      if (Array.isArray(critActions)) {
        for (const ca of critActions) {
          if (typeof ca === 'string') {
            newAlerts.push({ specialist: action.specialist, detail: ca });
          }
        }
      }
      const newScores = Array.isArray(analysis.scoring_systems_applied) ? analysis.scoring_systems_applied : [];
      return {
        ...state,
        specialistAnalyses: { ...state.specialistAnalyses, [action.specialist]: analysis },
        specialistStatuses: {
          ...state.specialistStatuses,
          [action.specialist]: hasCritical ? 'critical' : 'complete',
        },
        discussionThread: [...state.discussionThread, action.discussionMessage],
        criticalAlerts: [...state.criticalAlerts, ...newAlerts],
        scoringSystems: [...state.scoringSystems, ...newScores],
      };
    }

    case 'SPECIALIST_ERROR':
      return {
        ...state,
        specialistStatuses: {
          ...state.specialistStatuses,
          [action.specialist]: 'complete',
        },
      };

    case 'ANALYZE_DONE': {
      const questions = extractUserQuestions(state.specialistAnalyses);
      return {
        ...state,
        step: 'cross_consulting',
        pendingQuestions: questions,
        error: null,
      };
    }

    case 'CROSS_CONSULT_MESSAGE':
      return {
        ...state,
        crossConsultMessages: [...state.crossConsultMessages, action.message],
        discussionThread: [...state.discussionThread, action.discussionMessage],
      };

    case 'CROSS_CONSULT_DONE':
      return { ...state, step: 'synthesizing' };

    case 'ANALYSIS_COMPLETE': {
      const { intakeData, specialistAnalyses, discussionMessages } = action.data;
      const questions = extractUserQuestions(specialistAnalyses);
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

    // ── New multi-round cross-consult actions ─────────────────────────────

    case 'CROSS_CONSULT_ROUND_START': {
      const newRound: CrossConsultRound = { round: action.round, messages: [] };
      return {
        ...state,
        step: 'cross_consulting',
        currentRound: action.round,
        crossConsultRounds: [...state.crossConsultRounds, newRound],
      };
    }

    case 'CROSS_CONSULT_ROUND_MESSAGE': {
      const updatedRounds = state.crossConsultRounds.map((r) =>
        r.round === action.round
          ? { ...r, messages: [...r.messages, action.message] }
          : r
      );
      // Keep flat crossConsultMessages in sync for backward compat
      const flatMessages = flattenRounds(updatedRounds);
      return {
        ...state,
        crossConsultRounds: updatedRounds,
        crossConsultMessages: flatMessages,
        discussionThread: [...state.discussionThread, action.discussionMessage],
      };
    }

    case 'CROSS_CONSULT_ROUND_DONE': {
      return {
        ...state,
        currentRound: action.round,
      };
    }

    case 'ALL_ROUNDS_COMPLETE': {
      return {
        ...state,
        step: 'synthesizing',
        currentRound: action.totalRounds,
      };
    }

    // ── Discussion pause / steering ───────────────────────────────────────

    case 'DISCUSSION_PAUSED': {
      return {
        ...state,
        step: 'discussion_paused',
      };
    }

    case 'USER_STEERING_ACTION': {
      const steeringAction = action.action;
      switch (steeringAction.type) {
        case 'continue':
          return {
            ...state,
            step: 'cross_consulting',
            maxRounds: state.maxRounds + (steeringAction.additionalRounds ?? 1),
          };
        case 'proceed_to_synthesis':
          return {
            ...state,
            step: 'synthesizing',
            isStreaming: true,
            synthesizedPlan: '',
          };
        case 'ask_specialist':
        case 'inject_hypothesis':
          // These are handled by the hook — just go back to cross_consulting
          return {
            ...state,
            step: 'cross_consulting',
          };
        default:
          return state;
      }
    }

    // ── Append notes ──────────────────────────────────────────────────────

    case 'APPEND_NOTES': {
      return {
        ...state,
        rawNotes: state.rawNotes + '\n\n--- Additional Notes ---\n\n' + action.additionalNotes,
        step: 'parsing',
      };
    }

    case 'INCREMENTAL_INTAKE_COMPLETE': {
      const newAlerts = extractCriticalAlerts(action.updatedAnalyses);
      const newScores = extractScoringSystems(action.updatedAnalyses);
      const newStatuses = deriveStatuses(action.updatedAnalyses);
      return {
        ...state,
        step: 'cross_consulting',
        intakeData: action.intakeData,
        specialistAnalyses: { ...state.specialistAnalyses, ...action.updatedAnalyses },
        specialistStatuses: { ...state.specialistStatuses, ...newStatuses },
        discussionThread: [...state.discussionThread, ...action.discussionMessages],
        criticalAlerts: [...state.criticalAlerts, ...newAlerts],
        scoringSystems: [...state.scoringSystems, ...newScores],
      };
    }

    // ── Chat actions ──────────────────────────────────────────────────────

    case 'SET_CHATTING':
      return { ...state, step: 'chatting' };

    case 'CHAT_MESSAGE_SENT':
      return {
        ...state,
        chatHistory: [...state.chatHistory, action.message],
      };

    case 'CHAT_RESPONSE_RECEIVED': {
      const newChatHistory = [...state.chatHistory, action.message];
      const newCrossConsults = action.triggeredDiscussions
        ? [...state.crossConsultMessages, ...action.triggeredDiscussions]
        : state.crossConsultMessages;
      return {
        ...state,
        chatHistory: newChatHistory,
        crossConsultMessages: newCrossConsults,
      };
    }

    // ── Web search actions ────────────────────────────────────────────

    case 'TOGGLE_WEB_SEARCH':
      return { ...state, webSearchEnabled: action.enabled };

    case 'SPECIALIST_SEARCH':
      return {
        ...state,
        searchActivities: [...state.searchActivities, action.activity],
      };

    case 'SPECIALIST_CALCULATION':
      return {
        ...state,
        calculationActivities: [...state.calculationActivities, action.activity],
      };

    default:
      return state;
  }
}
