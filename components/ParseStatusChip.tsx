'use client';

import { useState } from 'react';
import { Check, AlertTriangle, FileText, ChevronDown, ChevronRight } from 'lucide-react';
import type { ParseReport } from '@/lib/types';

interface ParseStatusChipProps {
  parseReport: ParseReport;
}

export function ParseStatusChip({ parseReport }: ParseStatusChipProps) {
  const [expanded, setExpanded] = useState(false);

  const hardFailure =
    parseReport.confidence === 'low' &&
    parseReport.warnings.some((w) => /could not fully structure/i.test(w));

  const tone =
    parseReport.confidence === 'high'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : parseReport.confidence === 'medium'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-rose-50 text-rose-700 border-rose-200';

  const Icon =
    parseReport.confidence === 'high'
      ? Check
      : parseReport.confidence === 'medium'
      ? FileText
      : AlertTriangle;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${tone}`}
        aria-expanded={expanded}
      >
        <Icon className="size-3.5" aria-hidden="true" />
        <span>
          {parseReport.sectionsFound} sections identified · {parseReport.confidence} confidence
        </span>
        {expanded ? (
          <ChevronDown className="size-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3" aria-hidden="true" />
        )}
      </button>

      {hardFailure && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Could not fully structure your notes — specialists will analyze the
          normalized text. Quality may be reduced.
        </div>
      )}

      {expanded && (
        <div className="rounded-md border border-border/60 bg-muted/40 p-3 text-xs space-y-1.5 text-muted-foreground font-mono">
          <div>
            <span className="font-semibold text-foreground">Cleaning:</span>{' '}
            {parseReport.charsStripped.toLocaleString()} control chars stripped,{' '}
            {parseReport.quotesFolded.toLocaleString()} smart quotes folded,{' '}
            {parseReport.pageBreaksRemoved.toLocaleString()} page breaks removed
          </div>
          <div>
            <span className="font-semibold text-foreground">Structurer:</span>{' '}
            {parseReport.usedLLM ? `${parseReport.parserProvider} (Haiku)` : 'regex only'}
            {parseReport.latencyMs !== undefined && (
              <span> · {parseReport.latencyMs} ms</span>
            )}
          </div>
          {parseReport.truncated && (
            <div className="text-rose-700">
              <span className="font-semibold">Truncated:</span> input exceeded the
              200KB cap; only the first portion is being analyzed.
            </div>
          )}
          {parseReport.warnings.length > 0 && (
            <div className="space-y-0.5">
              <div className="font-semibold text-foreground">Warnings:</div>
              {parseReport.warnings.map((w, i) => (
                <div key={i} className="pl-2">• {w}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
