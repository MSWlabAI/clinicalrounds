'use client';

import { useState, useEffect, useRef } from 'react';
import { SPECIALIST_CONFIG, Specialist } from '@/lib/types';
import type { AnalysisStatus, SpecialistAnalysis, SpecialistSearchActivity, SpecialistCalculationActivity } from '@/lib/types';

interface ActivityEvent {
  id: string;
  type: 'start' | 'search' | 'complete' | 'critical' | 'calculation';
  specialist: Specialist;
  message: string;
  timestamp: number;
}

interface ActivityFeedProps {
  statuses: Record<string, AnalysisStatus>;
  searchActivities?: SpecialistSearchActivity[];
  calculationActivities?: SpecialistCalculationActivity[];
  specialistAnalyses: Record<string, SpecialistAnalysis>;
}

const MAX_EVENTS = 50;

export function ActivityFeed({ statuses, searchActivities, calculationActivities, specialistAnalyses }: ActivityFeedProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const seenRef = useRef(new Set<string>());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const newEvents: ActivityEvent[] = [];

    for (const [key, status] of Object.entries(statuses)) {
      const specialist = key as Specialist;
      const config = SPECIALIST_CONFIG[specialist];
      if (!config) continue;

      const startKey = `start:${specialist}`;
      if ((status === 'analyzing' || status === 'complete' || status === 'critical') && !seenRef.current.has(startKey)) {
        seenRef.current.add(startKey);
        newEvents.push({
          id: startKey,
          type: 'start',
          specialist,
          message: `${config.name} is analyzing the case...`,
          timestamp: Date.now(),
        });
      }

      const completeKey = `complete:${specialist}`;
      if ((status === 'complete' || status === 'critical') && !seenRef.current.has(completeKey)) {
        seenRef.current.add(completeKey);
        const analysis = specialistAnalyses[specialist];
        const findings = analysis?.findings?.length ?? 0;
        const concerns = analysis?.concerns?.length ?? 0;

        if (status === 'critical') {
          const criticalConcerns = analysis?.concerns?.filter(c => c.severity === 'critical') ?? [];
          const detail = criticalConcerns[0]?.detail ?? 'critical issue identified';
          newEvents.push({
            id: completeKey,
            type: 'critical',
            specialist,
            message: `CRITICAL: ${config.name} flagged ${detail.slice(0, 60)}${detail.length > 60 ? '...' : ''}`,
            timestamp: Date.now(),
          });
        } else {
          newEvents.push({
            id: completeKey,
            type: 'complete',
            specialist,
            message: `${config.name} complete — ${findings} finding${findings !== 1 ? 's' : ''}, ${concerns} concern${concerns !== 1 ? 's' : ''}`,
            timestamp: Date.now(),
          });
        }
      }
    }

    if (searchActivities) {
      for (const activity of searchActivities) {
        const searchKey = `search:${activity.specialist}:${activity.query}`;
        if (!seenRef.current.has(searchKey)) {
          seenRef.current.add(searchKey);
          const config = SPECIALIST_CONFIG[activity.specialist as Specialist];
          if (config) {
            newEvents.push({
              id: searchKey,
              type: 'search',
              specialist: activity.specialist as Specialist,
              message: `${config.name} searching: "${activity.query.slice(0, 50)}${activity.query.length > 50 ? '...' : ''}"`,
              timestamp: activity.timestamp,
            });
          }
        }
      }
    }

    if (calculationActivities) {
      for (const activity of calculationActivities) {
        const calcKey = `calc:${activity.specialist}:${activity.timestamp}`;
        if (!seenRef.current.has(calcKey)) {
          seenRef.current.add(calcKey);
          const config = SPECIALIST_CONFIG[activity.specialist as Specialist];
          if (config) {
            const codePreview = activity.code.split('\n')[0].slice(0, 50);
            newEvents.push({
              id: calcKey,
              type: 'calculation',
              specialist: activity.specialist as Specialist,
              message: `${config.name} calculating: ${codePreview}${activity.code.length > 50 ? '...' : ''}`,
              timestamp: activity.timestamp,
            });
          }
        }
      }
    }

    if (newEvents.length > 0) {
      // Idempotent thanks to seenRef-based dedup — each newEvent is appended
      // at most once across the component's lifetime, so this won't loop.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEvents(prev => [...prev, ...newEvents].slice(-MAX_EVENTS));
    }
  }, [statuses, searchActivities, calculationActivities, specialistAnalyses]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const typeStyles: Record<ActivityEvent['type'], string> = {
    start: 'text-blue-600',
    search: 'text-primary',
    complete: 'text-emerald-600',
    critical: 'text-destructive font-medium',
    calculation: 'text-amber-600',
  };

  const dotStyles: Record<ActivityEvent['type'], string> = {
    start: 'bg-blue-500',
    search: 'bg-primary',
    complete: 'bg-emerald-500',
    critical: 'bg-destructive',
    calculation: 'bg-amber-500',
  };

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Activity</h3>
        <p className="text-xs text-muted-foreground italic">Waiting for specialists...</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-4 pt-3 pb-2">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Live Activity</h3>
      </div>
      <div ref={scrollRef} className="px-4 pb-3 max-h-[480px] overflow-y-auto space-y-2">
        {events.map((event) => {
          const config = SPECIALIST_CONFIG[event.specialist];
          return (
            <div key={event.id} className="flex items-start gap-2 animate-fade-in">
              <div className={`size-1.5 rounded-full mt-1.5 shrink-0 ${dotStyles[event.type]}`} />
              <div className="min-w-0 flex-1">
                <p className={`text-xs leading-relaxed ${typeStyles[event.type]}`}>
                  <span className="mr-1">{config?.icon}</span>
                  {event.message}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
