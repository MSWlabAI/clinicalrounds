import { useCallback } from 'react';
import { readSSEStream } from './useSSEStream';
import type { Action } from '@/lib/reducer';
import { estimateTotalExchanges } from '@/lib/reducer';
import type {
  CaseState,
  SpecialistAnalysis,
  CrossConsultMessage,
  CrossConsultResponse,
  AdditionalDataResponse,
  IntakeData,
  AnalysisStatus,
  AnalyzeSSEEvent,
  CrossConsultSSEEvent,
  SpecialistCalculationActivity,
} from '@/lib/types';
import { Specialist } from '@/lib/types';

interface UseCaseAnalysisOptions {
  dispatch: React.Dispatch<Action>;
  state: CaseState;
}

interface UseCaseAnalysisReturn {
  runAnalysis: (rawNotes: string) => Promise<void>;
  streamSynthesis: (
    analyses: Record<string, SpecialistAnalysis>,
    crossConsults: CrossConsultMessage[],
    intakeData: IntakeData | null
  ) => Promise<void>;
  handleRefineWithAnswers: () => Promise<void>;
}

/**
 * Custom hook that encapsulates the full case analysis pipeline:
 * 1. Analyze (intake + specialist analyses via SSE)
 * 2. Cross-consult (via SSE)
 * 3. Synthesize (streaming text)
 *
 * Also provides handleRefineWithAnswers for post-synthesis refinement.
 */
export function useCaseAnalysis({ dispatch, state }: UseCaseAnalysisOptions): UseCaseAnalysisReturn {

  // ─── Streaming synthesis helper ────────────────────────────────────

  const streamSynthesis = useCallback(async (
    analyses: Record<string, SpecialistAnalysis>,
    crossConsults: CaseState['crossConsultMessages'],
    intakeData: CaseState['intakeData']
  ) => {
    dispatch({ type: 'SET_SYNTHESIZING' });

    const res = await fetch('/api/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analyses, crossConsults, intakeData }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Synthesis failed (${res.status})`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response stream available');

    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      dispatch({ type: 'STREAM_SYNTHESIS', chunk });
    }

    dispatch({ type: 'SYNTHESIS_COMPLETE' });
  }, [dispatch]);

  // ─── Auto-chained pipeline ─────────────────────────────────────────

  const runAnalysis = useCallback(async (rawNotes: string) => {
    dispatch({ type: 'START_ANALYSIS', rawNotes });

    // Initially mark all as analyzing — triage will refine this
    const allAnalyzing: Record<string, AnalysisStatus> = {};
    for (const s of Object.values(Specialist)) {
      if (s !== Specialist.ATTENDING) {
        allAnalyzing[s] = 'analyzing';
      }
    }
    dispatch({ type: 'SET_ANALYZING', statuses: allAnalyzing });

    try {
      // Step 1: Analyze via SSE stream
      const analyzeRes = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawNotes, webSearchEnabled: state.webSearchEnabled }),
      });

      if (!analyzeRes.ok) {
        const err = await analyzeRes.text();
        throw new Error(err || `Analysis failed (${analyzeRes.status})`);
      }

      // Accumulate results from the SSE stream for passing to next step
      let intakeData: IntakeData | null = null;
      const specialistAnalyses: Record<string, SpecialistAnalysis> = {};

      await readSSEStream<AnalyzeSSEEvent | { type: 'error'; error: string }>(analyzeRes, (event) => {
        if (event.type === 'error') {
          throw new Error((event as { type: 'error'; error: string }).error);
        }
        switch (event.type) {
          case 'parse_complete':
            dispatch({ type: 'PARSE_COMPLETE', parseReport: event.parseReport });
            break;
          case 'intake_complete':
            intakeData = event.intakeData;
            dispatch({ type: 'INTAKE_COMPLETE', intakeData: event.intakeData });
            break;
          case 'triage_complete':
            dispatch({
              type: 'TRIAGE_COMPLETE',
              selectedSpecialists: event.selectedSpecialists,
              skippedSpecialists: event.skippedSpecialists,
              reasoning: event.reasoning,
            });
            break;
          case 'specialist_complete':
            specialistAnalyses[event.specialist] = event.analysis;
            dispatch({
              type: 'SPECIALIST_COMPLETE',
              specialist: event.specialist,
              analysis: event.analysis,
              discussionMessage: event.discussionMessage,
            });
            break;
          case 'specialist_error':
            dispatch({ type: 'SPECIALIST_ERROR', specialist: event.specialist, error: event.error });
            break;
          case 'specialist_search':
            dispatch({
              type: 'SPECIALIST_SEARCH',
              activity: {
                specialist: event.specialist,
                query: event.query,
                citations: [],
                timestamp: Date.now(),
              },
            });
            break;
          case 'specialist_calculation':
            dispatch({
              type: 'SPECIALIST_CALCULATION',
              activity: {
                specialist: event.specialist,
                code: event.code,
                result: '',
                success: true,
                timestamp: Date.now(),
              },
            });
            break;
          case 'analyze_done':
            dispatch({ type: 'ANALYZE_DONE' });
            break;
        }
      });

      if (!intakeData) throw new Error('Intake data not received');

      // Step 2: Cross-consult via SSE stream
      const crossConsultMessages: CrossConsultMessage[] = [];

      const crossRes = await fetch('/api/cross-consult?stream=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          analyses: specialistAnalyses,
          intakeData,
        }),
      });

      if (!crossRes.ok) {
        const err = await crossRes.text();
        throw new Error(err || `Cross-consult failed (${crossRes.status})`);
      }

      await readSSEStream<CrossConsultSSEEvent | { type: 'error'; error: string }>(crossRes, (event) => {
        if (event.type === 'error') {
          throw new Error((event as { type: 'error'; error: string }).error);
        }
        switch (event.type) {
          case 'cross_consult_message':
            crossConsultMessages.push(event.message);
            dispatch({
              type: 'CROSS_CONSULT_MESSAGE',
              message: event.message,
              discussionMessage: event.discussionMessage,
            });
            break;
          case 'cross_consult_done':
            dispatch({ type: 'CROSS_CONSULT_DONE' });
            break;
        }
      });

      // Step 3: Synthesize (streaming)
      await streamSynthesis(specialistAnalyses, crossConsultMessages, intakeData);
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Analysis failed' });
    }
  }, [dispatch, streamSynthesis, state.webSearchEnabled]);

  // ─── Refine with answers (post-synthesis) ──────────────────────────

  const handleRefineWithAnswers = useCallback(async () => {
    if (!state.intakeData) return;

    try {
      // Re-analyze with user answers
      const reAnalyzeRes = await fetch('/api/additional-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers: state.userAnswers,
          previousAnalyses: state.specialistAnalyses,
          intakeData: state.intakeData,
        }),
      });

      if (!reAnalyzeRes.ok) {
        const err = await reAnalyzeRes.text();
        throw new Error(err || `Re-analysis failed (${reAnalyzeRes.status})`);
      }

      const reAnalyzeData: AdditionalDataResponse = await reAnalyzeRes.json();
      dispatch({ type: 'ADDITIONAL_DATA_COMPLETE', data: reAnalyzeData });

      // Cross-consult on updated analyses
      const updatedAnalyses = { ...state.specialistAnalyses, ...reAnalyzeData.updatedAnalyses };

      dispatch({ type: 'SET_CROSS_CONSULTING' });
      const crossRes = await fetch('/api/cross-consult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analyses: updatedAnalyses, intakeData: state.intakeData }),
      });

      if (!crossRes.ok) {
        const err = await crossRes.text();
        throw new Error(err || `Cross-consult failed (${crossRes.status})`);
      }

      const crossData: CrossConsultResponse = await crossRes.json();
      dispatch({ type: 'CROSS_CONSULT_COMPLETE', data: crossData });

      // Re-synthesize
      const mergedAnalyses = { ...updatedAnalyses, ...crossData.updatedAnalyses };
      await streamSynthesis(mergedAnalyses, crossData.messages, state.intakeData);
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Refinement failed' });
    }
  }, [state.intakeData, state.userAnswers, state.specialistAnalyses, dispatch, streamSynthesis]);

  return {
    runAnalysis,
    streamSynthesis,
    handleRefineWithAnswers,
  };
}
