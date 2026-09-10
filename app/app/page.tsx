'use client';

import { useReducer, useCallback, useState } from 'react';
import { WorkflowNav } from '@/components/WorkflowNav';
import { UploadView } from '@/components/views/UploadView';
import { TimelineReviewView } from '@/components/views/TimelineReviewView';
import { AnalysisView } from '@/components/views/AnalysisView';
import { DiscussionView } from '@/components/views/DiscussionView';
import { AssessmentView } from '@/components/views/AssessmentView';
import { ChatView } from '@/components/views/ChatView';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Stethoscope, RotateCcw } from 'lucide-react';
import { formatCost } from '@/lib/utils';
import { caseReducer, initialState } from '@/lib/reducer';
import { useCaseAnalysis } from '@/lib/hooks/useCaseAnalysis';
import { PasscodeGate } from '@/components/PasscodeGate';
import type { TemporalIntakeData, SpecialistChatMessage } from '@/lib/types';
import { Specialist } from '@/lib/types';
import { generateId } from '@/lib/utils';

// ─── Page Component ──────────────────────────────────────────────────────────

export default function Home() {
  const [state, dispatch] = useReducer(caseReducer, initialState);
  const [isRefining, setIsRefining] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  // viewOverride: when user clicks a completed step in WorkflowNav for read-only review
  const [viewOverride, setViewOverride] = useState<string | null>(null);

  const { runAnalysis, streamSynthesis, handleRefineWithAnswers: refineWithAnswers } = useCaseAnalysis({ dispatch, state });

  // ─── Handlers ────────────────────────────────────────────────────────

  const handleRefineWithAnswers = useCallback(async () => {
    setIsRefining(true);
    try {
      await refineWithAnswers();
    } finally {
      setIsRefining(false);
    }
  }, [refineWithAnswers]);

  const handleAnswerQuestion = useCallback((questionId: string, answer: string | null) => {
    dispatch({ type: 'ANSWER_QUESTION', questionId, answer });
  }, []);

  const handleReset = useCallback(() => {
    dispatch({ type: 'RESET' });
    setViewOverride(null);
  }, []);

  const handleEnterChat = useCallback(() => {
    dispatch({ type: 'SET_CHATTING' });
    setViewOverride(null);
  }, []);

  const handleAppendNotes = useCallback(async (additionalNotes: string) => {
    if (!state.intakeData) return;
    setIsProcessing(true);
    try {
      dispatch({ type: 'APPEND_NOTES', additionalNotes });
      const res = await fetch('/api/append-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          additionalNotes,
          existingIntakeData: state.intakeData,
          existingAnalyses: state.specialistAnalyses,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || `Append notes failed (${res.status})`);
      }
      const data = await res.json();
      dispatch({
        type: 'INCREMENTAL_INTAKE_COMPLETE',
        intakeData: data.updatedIntakeData,
        updatedAnalyses: data.updatedAnalyses,
        discussionMessages: data.discussionMessages,
      });
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to append notes' });
    } finally {
      setIsProcessing(false);
    }
  }, [state.intakeData, state.specialistAnalyses]);

  const handleSendChatMessage = useCallback(async (specialist: Specialist, message: string) => {
    if (!state.intakeData) return;
    setIsProcessing(true);

    const userMessage: SpecialistChatMessage = {
      id: generateId(),
      role: 'user',
      specialist,
      content: message,
      timestamp: Date.now(),
    };
    dispatch({ type: 'CHAT_MESSAGE_SENT', message: userMessage });

    try {
      const res = await fetch('/api/specialist-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          specialist,
          message,
          chatHistory: state.chatHistory,
          intakeData: state.intakeData,
          analyses: state.specialistAnalyses,
          crossConsults: state.crossConsultMessages,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(err || `Chat failed (${res.status})`);
      }

      // Parse SSE stream from specialist-chat endpoint
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let responseMessage: SpecialistChatMessage | null = null;
      let triggeredDiscussions: import('@/lib/types').CrossConsultMessage[] = [];
      let buffer = '';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const json = line.slice(6).trim();
            if (!json) continue;
            try {
              const event = JSON.parse(json);
              if (event.type === 'chat_response') {
                responseMessage = event.message;
              } else if (event.type === 'chat_triggered_discussion') {
                triggeredDiscussions = event.discussions;
              } else if (event.type === 'error') {
                throw new Error(event.error);
              }
            } catch (e) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }
      }

      if (responseMessage) {
        dispatch({
          type: 'CHAT_RESPONSE_RECEIVED',
          message: responseMessage,
          triggeredDiscussions,
        });
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Chat failed' });
    } finally {
      setIsProcessing(false);
    }
  }, [state.intakeData, state.chatHistory, state.specialistAnalyses, state.crossConsultMessages]);

  const handleContinueDiscussion = useCallback((additionalRounds: number) => {
    dispatch({
      type: 'USER_STEERING_ACTION',
      action: { type: 'continue', additionalRounds },
    });
    setViewOverride(null);
  }, []);

  const handleAskSpecialist = useCallback((specialist: Specialist, question: string) => {
    dispatch({
      type: 'USER_STEERING_ACTION',
      action: { type: 'ask_specialist', specialist, question },
    });
    setViewOverride(null);
  }, []);

  const handleInjectHypothesis = useCallback((hypothesis: string) => {
    dispatch({
      type: 'USER_STEERING_ACTION',
      action: { type: 'inject_hypothesis', question: hypothesis },
    });
    setViewOverride(null);
  }, []);

  const handleProceedToSynthesis = useCallback(() => {
    dispatch({
      type: 'USER_STEERING_ACTION',
      action: { type: 'proceed_to_synthesis' },
    });
    setViewOverride(null);
    // Trigger synthesis
    streamSynthesis(state.specialistAnalyses, state.crossConsultMessages, state.intakeData);
  }, [streamSynthesis, state.specialistAnalyses, state.crossConsultMessages, state.intakeData]);

  const handleStepClick = useCallback((step: string) => {
    // Allow viewing completed steps as read-only
    setViewOverride(step);
  }, []);

  const handleToggleWebSearch = useCallback((enabled: boolean) => {
    dispatch({ type: 'TOGGLE_WEB_SEARCH', enabled });
  }, []);

  const handleSubmit = useCallback((rawNotes: string) => {
    setViewOverride(null);
    runAnalysis(rawNotes);
  }, [runAnalysis]);

  // ─── Derived State ───────────────────────────────────────────────────

  const hasIntakeData = state.intakeData !== null;
  const hasAnalyses = Object.keys(state.specialistAnalyses).length > 0;
  const hasCrossConsults = state.crossConsultMessages.length > 0;
  const hasSynthesis = state.synthesizedPlan.length > 0;

  // ─── Determine which view to render ─────────────────────────────────

  function renderView() {
    // If user clicked a completed step for review
    if (viewOverride) {
      switch (viewOverride) {
        case 'upload':
          // Not useful to revisit, clear override
          setViewOverride(null);
          break;
        case 'timeline':
          if (state.intakeData && 'encounters' in state.intakeData) {
            return (
              <TimelineReviewView
                intakeData={state.intakeData as TemporalIntakeData}
                onProceed={() => setViewOverride(null)}
              />
            );
          }
          setViewOverride(null);
          break;
        case 'analysis':
          if (hasAnalyses) {
            return (
              <AnalysisView
                specialistAnalyses={state.specialistAnalyses}
                specialistStatuses={state.specialistStatuses}
                scoringSystems={state.scoringSystems}
                discussionThread={state.discussionThread}
                isAnalyzing={false}
                searchActivities={state.searchActivities}
                parseReport={state.parseReport}
              />
            );
          }
          setViewOverride(null);
          break;
        case 'discussion':
          if (hasCrossConsults) {
            return (
              <DiscussionView
                crossConsultMessages={state.crossConsultMessages}
                crossConsultRounds={state.crossConsultRounds}
                currentRound={state.currentRound}
                maxRounds={state.maxRounds}
                specialistAnalyses={state.specialistAnalyses}
                isActive={false}
                isPaused={false}
                onContinue={handleContinueDiscussion}
                onAskSpecialist={handleAskSpecialist}
                onInjectHypothesis={handleInjectHypothesis}
                onProceedToSynthesis={handleProceedToSynthesis}
              />
            );
          }
          setViewOverride(null);
          break;
        case 'assessment':
          if (hasSynthesis) {
            return (
              <AssessmentView
                synthesizedPlan={state.synthesizedPlan}
                isStreaming={false}
                criticalAlerts={state.criticalAlerts}
                pendingQuestions={state.pendingQuestions}
                onAnswerQuestion={handleAnswerQuestion}
                onRefine={handleRefineWithAnswers}
                isRefining={isRefining}
                isComplete={state.step === 'complete' || state.step === 'chatting'}
                onEnterChat={handleEnterChat}
                intakeData={state.intakeData}
                specialistAnalyses={state.specialistAnalyses}
                crossConsultMessages={state.crossConsultMessages}
                scoringSystems={state.scoringSystems}
              />
            );
          }
          setViewOverride(null);
          break;
      }
    }

    // Render based on current step
    switch (state.step) {
      case 'idle':
        return (
          <UploadView
            onSubmit={handleSubmit}
            webSearchEnabled={state.webSearchEnabled}
            onToggleWebSearch={handleToggleWebSearch}
            parseReport={state.parseReport}
          />
        );

      case 'parsing':
        return (
          <UploadView
            onSubmit={handleSubmit}
            isParsing
            webSearchEnabled={state.webSearchEnabled}
            onToggleWebSearch={handleToggleWebSearch}
            parseReport={state.parseReport}
          />
        );

      case 'analyzing':
        return (
          <AnalysisView
            specialistAnalyses={state.specialistAnalyses}
            specialistStatuses={state.specialistStatuses}
            scoringSystems={state.scoringSystems}
            discussionThread={state.discussionThread}
            isAnalyzing
            searchActivities={state.searchActivities}
            parseReport={state.parseReport}
          />
        );

      case 'cross_consulting':
        return (
          <DiscussionView
            crossConsultMessages={state.crossConsultMessages}
            crossConsultRounds={state.crossConsultRounds}
            currentRound={state.currentRound}
            maxRounds={state.maxRounds}
            specialistAnalyses={state.specialistAnalyses}
            isActive
            isPaused={false}
            onContinue={handleContinueDiscussion}
            onAskSpecialist={handleAskSpecialist}
            onInjectHypothesis={handleInjectHypothesis}
            onProceedToSynthesis={handleProceedToSynthesis}
          />
        );

      case 'discussion_paused':
        return (
          <DiscussionView
            crossConsultMessages={state.crossConsultMessages}
            crossConsultRounds={state.crossConsultRounds}
            currentRound={state.currentRound}
            maxRounds={state.maxRounds}
            specialistAnalyses={state.specialistAnalyses}
            isActive={false}
            isPaused
            onContinue={handleContinueDiscussion}
            onAskSpecialist={handleAskSpecialist}
            onInjectHypothesis={handleInjectHypothesis}
            onProceedToSynthesis={handleProceedToSynthesis}
          />
        );

      case 'synthesizing':
        return (
          <AssessmentView
            synthesizedPlan={state.synthesizedPlan}
            isStreaming={state.isStreaming}
            criticalAlerts={state.criticalAlerts}
            pendingQuestions={state.pendingQuestions}
            onAnswerQuestion={handleAnswerQuestion}
            onRefine={handleRefineWithAnswers}
            isRefining={isRefining}
            intakeData={state.intakeData}
            specialistAnalyses={state.specialistAnalyses}
            crossConsultMessages={state.crossConsultMessages}
            scoringSystems={state.scoringSystems}
          />
        );

      case 'complete':
        return (
          <AssessmentView
            synthesizedPlan={state.synthesizedPlan}
            isStreaming={false}
            criticalAlerts={state.criticalAlerts}
            pendingQuestions={state.pendingQuestions}
            onAnswerQuestion={handleAnswerQuestion}
            onRefine={handleRefineWithAnswers}
            isRefining={isRefining}
            isComplete
            onEnterChat={handleEnterChat}
            intakeData={state.intakeData}
            specialistAnalyses={state.specialistAnalyses}
            crossConsultMessages={state.crossConsultMessages}
            scoringSystems={state.scoringSystems}
          />
        );

      case 'chatting':
        return (
          <ChatView
            chatHistory={state.chatHistory}
            specialistAnalyses={state.specialistAnalyses}
            intakeData={state.intakeData}
            onSendMessage={handleSendChatMessage}
            onAppendNotes={handleAppendNotes}
            isProcessing={isProcessing}
          />
        );

      default:
        return null;
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <PasscodeGate>
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border/60 glass">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-primary/10 rounded-lg">
              <Stethoscope className="size-4 text-primary" aria-hidden="true" />
            </div>
            <h1 className="text-lg font-bold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text">ClinicalRounds</h1>
          </div>
          <div className="flex items-center gap-3">
            {state.tokenUsage.estimatedCost > 0 && (
              <span className="text-xs text-muted-foreground font-mono hidden sm:block bg-muted/50 px-2 py-0.5 rounded-md">
                {formatCost(state.tokenUsage.input, state.tokenUsage.output)}
              </span>
            )}
            {state.step !== 'idle' && (
              <Button variant="outline" size="sm" onClick={handleReset} className="gap-1.5 press-scale">
                <RotateCcw className="size-3.5" aria-hidden="true" />
                New Case
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Workflow Navigation */}
      <WorkflowNav
        currentStep={state.step}
        hasIntakeData={hasIntakeData}
        hasAnalyses={hasAnalyses}
        hasCrossConsults={hasCrossConsults}
        hasSynthesis={hasSynthesis}
        onStepClick={handleStepClick}
      />

      {/* Content */}
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {/* Error Banner */}
        {state.error && (
          <Alert variant="destructive" className="mb-6">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}

        {renderView()}
      </div>
    </div>
    </PasscodeGate>
  );
}
