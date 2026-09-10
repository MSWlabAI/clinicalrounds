'use client';

import { useState, useEffect } from 'react';
import { SpecialistGrid } from '@/components/SpecialistGrid';
import { ScoringSystemsSidebar } from '@/components/ScoringSystemsSidebar';
import { ActivityFeed } from '@/components/ActivityFeed';
import { TeamDiscussion } from '@/components/TeamDiscussion';
import { ParseStatusChip } from '@/components/ParseStatusChip';
import { Users } from 'lucide-react';
import type { SpecialistAnalysis, AnalysisStatus, ScoringSystem, DiscussionMessage, SpecialistSearchActivity, SpecialistCalculationActivity, ParseReport } from '@/lib/types';

interface AnalysisViewProps {
  specialistAnalyses: Record<string, SpecialistAnalysis>;
  specialistStatuses: Record<string, AnalysisStatus>;
  scoringSystems: ScoringSystem[];
  discussionThread: DiscussionMessage[];
  isAnalyzing: boolean;
  searchActivities?: SpecialistSearchActivity[];
  calculationActivities?: SpecialistCalculationActivity[];
  parseReport?: ParseReport | null;
}

export function AnalysisView({
  specialistAnalyses,
  specialistStatuses,
  scoringSystems,
  discussionThread,
  isAnalyzing,
  searchActivities,
  calculationActivities,
  parseReport,
}: AnalysisViewProps) {
  const hasAnalyses = Object.keys(specialistAnalyses).length > 0;
  const hasStatuses = Object.keys(specialistStatuses).length > 0;

  const total = 16;
  const completed = Object.values(specialistStatuses).filter(
    s => s === 'complete' || s === 'critical'
  ).length;

  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isAnalyzing) return;
    // Reset timer at the start of each analysis run. The increment below runs
    // inside an interval callback, not synchronously, so it isn't flagged.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setElapsed(0);
    const interval = setInterval(() => {
      setElapsed(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isAnalyzing]);

  const formatElapsed = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px] animate-fade-in-up">
      {/* Main Column */}
      <div className="space-y-6 min-w-0">
        {/* Parse status (preserved across the analysis) */}
        {parseReport && (
          <ParseStatusChip parseReport={parseReport} />
        )}

        {/* Phase Banner */}
        {isAnalyzing && (
          <div className="gradient-hero rounded-xl px-5 py-4 animate-fade-in">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="relative flex size-3">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex size-3 rounded-full bg-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold">
                    {hasStatuses ? 'Specialist Analysis in Progress' : 'Assembling the team...'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {hasStatuses
                      ? `${completed} of ${total} complete`
                      : '16 specialists are reviewing the case simultaneously'}
                  </p>
                </div>
              </div>
              <div className="text-xs font-mono text-muted-foreground bg-background/50 px-2.5 py-1 rounded-md">
                {formatElapsed(elapsed)}
              </div>
            </div>
          </div>
        )}

        {/* Assembling placeholder when no statuses yet */}
        {isAnalyzing && !hasStatuses && (
          <div className="flex flex-col items-center justify-center gap-3 py-12 animate-fade-in">
            <div className="p-3 bg-primary/10 rounded-full">
              <Users className="size-6 text-primary" aria-hidden="true" />
            </div>
          </div>
        )}

        {(hasAnalyses || hasStatuses) && (
          <SpecialistGrid
            analyses={specialistAnalyses}
            statuses={specialistStatuses}
            searchActivities={searchActivities}
            calculationActivities={calculationActivities}
          />
        )}

        {discussionThread.length > 0 && (
          <TeamDiscussion messages={discussionThread} />
        )}
      </div>

      {/* Right Sidebar */}
      <div className="space-y-6">
        {isAnalyzing && (
          <div className="animate-slide-in-right">
            <ActivityFeed
              statuses={specialistStatuses}
              searchActivities={searchActivities}
              calculationActivities={calculationActivities}
              specialistAnalyses={specialistAnalyses}
            />
          </div>
        )}
        {scoringSystems.length > 0 && (
          <div className="animate-slide-in-right">
            <ScoringSystemsSidebar scores={scoringSystems} />
          </div>
        )}
      </div>
    </div>
  );
}
