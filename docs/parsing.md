# ParseStage — Universal Note Intake

ClinicalRounds receives raw Epic copy-paste from clinicians. That paste is
often messy: smart quotes, page-break sentinels, control characters,
hyphenated line wraps, repeated print-header furniture. Before we hand it
to the 9 specialist agents, we run a tiered cleanup so the LLM intake
parser stops returning "could not parse" errors.

## The pipeline

```
raw paste
  └─ normalizeClinicalText()        sync, ~1 ms
        └─ detectSections()         sync, ~5 ms
              └─ getParser().structure()   async, only if confidence < high
                    └─ Anthropic Haiku 4.5 (default) or Mistral (flagged off)
```

`parseClinicalNote(raw)` is the single entry point. It is guaranteed never
to throw — on failure it returns a `ParsedClinicalNote` with
`confidence='low'` and a warning, and the orchestrator proceeds anyway.

## Confidence policy

| sections found | confidence | LLM structurer  | placement                                        |
| -------------- | ---------- | --------------- | ------------------------------------------------ |
| ≥ 6            | high       | skipped         | regex output is canonical                        |
| 3–5            | medium     | runs in parallel with the first specialist wave  | LLM augments, regex wins on conflict             |
| < 3            | low        | runs serially before fan-out                     | free-text dump — banner shown to user            |

After the LLM call, confidence is recomputed against the merged section
count. A free-text note that the LLM successfully segments will be
upgraded to medium or high.

## Provider abstraction

The `Parser` interface in `lib/parse/structure.ts` requires a single
method:

```ts
structure(text: string): Promise<{ sections, warnings }>
```

Two implementations ship today:

- `lib/parse/providers/anthropic.ts` — Claude Haiku 4.5 with tool-use
  structured output. Default. Requires `ANTHROPIC_API_KEY`.
- `lib/parse/providers/mistral.ts` — Mistral with `response_format: json_object`.
  **OFF by default**. Activated by setting `PARSER_PROVIDER=mistral` AND
  `MISTRAL_API_KEY`. If the flag is set without the key, we fall back to
  Anthropic so PHI never leaves the platform unintentionally. Pending BAA
  / legal review before turning on.

To add a new provider, implement `Parser` and add a branch in `getParser()`.
The structurer must NEVER produce free-form clinical content — its only
contract is to re-segment the input into named sections using verbatim
substrings.

## Limits

- Hard cap: 200 KB / ~50k tokens. Above that we truncate and emit a
  warning. Specialists only see the first portion.
- The deterministic pass always runs and is dependency-free.
- The LLM pass is conditional and parallelizable.
- No PHI in logs. We log counts (chars stripped, sections found) and
  latency only.

## Local debugging

```
pnpm tsx scripts/parse-fixture.ts                # list fixtures
pnpm tsx scripts/parse-fixture.ts messy_paste_with_artifacts.txt
pnpm tsx scripts/parse-fixture.ts /path/to/note.txt
```

Prints the cleaning report, confidence, warnings, and each detected
section in turn.

## Adding a fixture

1. Drop a `.txt` file in `lib/parse/__fixtures__/` containing realistic
   nasty paste (smart quotes, BOMs, page breaks — see `parser_smoke.txt`
   for an exhaustive sample).
2. Add a snapshot test in `tests/unit/parse/parse.test.ts`.
3. Run `pnpm tsx scripts/parse-fixture.ts <name>` to verify visually.

## API

`POST /api/parse`

```ts
// request
{ rawNotes: string, skipLLM?: boolean }
// response
{ raw, normalized, sections, warnings, confidence, cleaningReport }
```

The `/api/analyze` SSE stream now emits a `parse_complete` event before
`intake_complete`. The UI uses it to show a confidence chip and the
"could not fully structure" banner without waiting for the rest of the
pipeline.
