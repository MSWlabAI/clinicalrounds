import { NextRequest } from 'next/server';
import { runIntake, runSpecialistsStreaming, triageSpecialists } from '@/lib/orchestrator';
import type { AnalyzeRequest, AnalyzeSSEEvent, DiscussionMessage } from '@/lib/types';
import { Specialist, SPECIALIST_CONFIG } from '@/lib/types';

// 9 parallel specialist Claude calls need extended timeout (extra buffer for web search)
export const maxDuration = 180;

export async function POST(request: NextRequest) {
  const body: AnalyzeRequest = await request.json();

  if (!body.rawNotes || body.rawNotes.trim().length === 0) {
    return new Response(JSON.stringify({ error: 'Clinical notes are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const webSearchEnabled = body.webSearchEnabled ?? false;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: AnalyzeSSEEvent) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }

      try {
        // Step 1: Parse raw notes into structured intake data (with ParseStage + sanitization)
        const { intakeData, sanitizationWarnings, parsedNote } = await runIntake(body.rawNotes);

        // Surface ParseStage telemetry to the UI before intake_complete so
        // the user sees a confidence chip and any "couldn't fully structure"
        // banner without waiting for the rest of the pipeline.
        send({
          type: 'parse_complete',
          parseReport: {
            confidence: parsedNote.confidence,
            sectionsFound: parsedNote.cleaningReport.sectionsFound,
            usedLLM: parsedNote.cleaningReport.usedLLM,
            parserProvider: parsedNote.cleaningReport.parserProvider,
            charsStripped: parsedNote.cleaningReport.charsStripped,
            quotesFolded: parsedNote.cleaningReport.quotesFolded,
            pageBreaksRemoved: parsedNote.cleaningReport.pageBreaksRemoved,
            truncated: parsedNote.cleaningReport.truncated,
            latencyMs: parsedNote.cleaningReport.latencyMs,
            warnings: parsedNote.warnings,
          },
        });

        send({
          type: 'intake_complete',
          intakeData,
          sanitizationWarnings: sanitizationWarnings.length > 0 ? sanitizationWarnings : undefined,
        });

        // Step 2: Triage — determine which specialists are relevant
        const allNonAttending = Object.values(Specialist).filter(s => s !== Specialist.ATTENDING);
        let selectedSpecialists: Specialist[];
        let skippedSpecialists: Specialist[];
        let triageReasoning: string;

        try {
          const triage = await triageSpecialists(intakeData);
          selectedSpecialists = triage.specialists;
          skippedSpecialists = allNonAttending.filter(s => !selectedSpecialists.includes(s));
          triageReasoning = triage.reasoning;
        } catch (err) {
          console.error('[analyze] Triage failed, running all specialists:', err);
          selectedSpecialists = allNonAttending;
          skippedSpecialists = [];
          triageReasoning = 'Triage failed — running all specialists as fallback';
        }

        send({
          type: 'triage_complete',
          selectedSpecialists,
          skippedSpecialists,
          reasoning: triageReasoning,
        });

        // Step 3: Run selected specialists in parallel, streaming results
        let completedCount = 0;
        const totalSpecialists = selectedSpecialists.length;

        await runSpecialistsStreaming(
          intakeData,
          (specialist, analysis) => {
            completedCount++;
            const discussionMessage: DiscussionMessage = {
              specialist: SPECIALIST_CONFIG[specialist]?.name ?? specialist,
              content: analysis.findings?.length
                ? `Key findings: ${analysis.findings.slice(0, 3).join('; ')}`
                : 'Analysis complete.',
              timestamp: Date.now(),
            };
            send({ type: 'specialist_complete', specialist, analysis, discussionMessage });
          },
          (specialist, error) => {
            completedCount++;
            send({ type: 'specialist_error', specialist, error });
          },
          {
            webSearchEnabled,
            onSearch: (specialist, query) => {
              send({ type: 'specialist_search', specialist, query });
            },
            onCalculation: (specialist, code) => {
              send({ type: 'specialist_calculation', specialist, code } as unknown as AnalyzeSSEEvent);
            },
            parsedNote,
          },
          selectedSpecialists
        );

        send({ type: 'analyze_done', totalSpecialists, completedCount });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to analyze clinical notes';
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', error: msg })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
