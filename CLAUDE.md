# ClinicalRounds

AI-powered multidisciplinary clinical case review tool.

## What This Is
A web app where clinicians paste Epic notes and get instant analysis
from a team of 9 AI specialist agents that reason collaboratively.

## Architecture
- No database. All state in React. Sessions are ephemeral.
- No auth. No user accounts.
- No PHI storage. Notes exist only in browser memory.
- 9 parallel Claude API calls for specialist analysis.
- 1-2 cross-consultation rounds between specialists.
- Opus for final synthesis, Sonnet for all specialists.

## Key Files
- /app/page.tsx — Public hero / landing page (no PasscodeGate).
- /app/app/page.tsx — Gated case-review tool (wraps PasscodeGate + workflow).
- /lib/prompts/ — System prompts for each specialist. These are
  LARGE and contain embedded clinical expertise. Do not simplify them.
- /lib/orchestrator.ts — Core logic for managing the multi-agent flow.
- /app/api/ — API routes for each step of the analysis pipeline.

## Code Standards
- TypeScript strict mode
- All specialist outputs must conform to SpecialistAnalysis type
- Use streaming for the synthesis API route
- Parallel API calls via Promise.all() — never sequential

## Clinical Disclaimer
Every page must show: "AI clinical reasoning aid. Does not replace
physician clinical judgment. Not for diagnostic or treatment decisions."
