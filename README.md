<p align="center">
  <img src="https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=next.js" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/React-19-blue?style=flat-square&logo=react" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-strict-blue?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Claude-Opus%20%2B%20Sonnet-cc785c?style=flat-square&logo=anthropic" alt="Claude API" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License" />
</p>

# ClinicalRounds

**Instant AI-powered multidisciplinary case review for complex inpatients.**

Paste a clinical note. 9 AI specialists analyze in parallel, cross-consult each other, and synthesize a unified Assessment & Plan -- in under 60 seconds.

No database. No login. No PHI storage. Just paste and go.

---

## The Problem

Complex hospitalized patients need multidisciplinary input. A real team conference means coordinating cardiology, nephrology, hematology, pharmacy, and more -- days of scheduling, hours of rounding. Most patients never get one.

ClinicalRounds gives every patient an instant multidisciplinary review.

## How It Works

```
                    +-----------------+
                    |  Paste Clinical |
                    |     Note        |
                    +--------+--------+
                             |
                    +--------v--------+
                    |  Intake Parser  |
                    |   (Sonnet)      |
                    +--------+--------+
                             |
          +------------------+------------------+
          |         |        |        |         |
     +----v---+ +--v----+ +-v-----+ +v------+ +v---------+
     |Cardio  | |Pulm   | |Nephro | |Heme   | | +5 more  |
     |logy    | |/CC    | |logy   | |/Onc   | | speciali |
     |(Sonnet)| |(Sonnet)| |(Sonnet)| |(Sonnet)| | sts     |
     +----+---+ +--+----+ +-+-----+ ++------+ ++---------+
          |         |        |        |         |
          +------------------+------------------+
                             |
                    +--------v--------+
                    | Cross-Consult   |
                    | (Specialists    |
                    |  question each  |
                    |  other)         |
                    +--------+--------+
                             |
                    +--------v--------+
                    |  Attending      |
                    |  Synthesis      |
                    |  (Opus)         |
                    +--------+--------+
                             |
                    +--------v--------+
                    |  Problem-Based  |
                    |  A/P Output     |
                    +-----------------+
```

### 1. Paste Your Note
Copy any clinical note from your EHR -- H&P, progress note, consult, discharge summary. No login. No integration. Just paste.

### 2. 9 Specialists Analyze in Parallel
All specialists review simultaneously from their domain perspective. They cross-consult each other, flag critical findings, and ask you for missing data.

### 3. Copy the A/P
Get a unified Assessment & Plan organized by problem, with specialist-attributed recommendations, validated scoring systems, and guideline citations. One-click copy into your note.

## The Specialist Team

| Specialist | Focus Areas | Model |
|---|---|---|
| **Attending Hospitalist** | Systems-based assessment, care coordination, risk stratification, disposition | Opus |
| **Cardiology** | ACS evaluation, heart failure, arrhythmia, hemodynamics, GDMT optimization | Sonnet |
| **Pulm / Critical Care** | Ventilator management, ABG interpretation, ARDS, respiratory failure | Sonnet |
| **Nephrology** | Electrolytes, AKI staging, acid-base, dialysis assessment, CKD management | Sonnet |
| **Hepatology** | Liver function, cirrhosis, MELD scoring, hepatic encephalopathy | Sonnet |
| **Hematology** | Coagulopathy, transfusion medicine, anticoagulation, DIC evaluation | Sonnet |
| **Infectious Disease** | Antimicrobial stewardship, culture interpretation, empiric coverage | Sonnet |
| **Radiology** | Imaging correlation, incidental findings, follow-up recommendations | Sonnet |
| **Clinical Pharmacy** | Drug interactions, renal/hepatic dosing, medication reconciliation | Sonnet |
| **Endocrinology** | Glycemic management, thyroid, adrenal, inpatient insulin protocols | Sonnet |
| **Neurology** | Altered mental status, stroke, seizure, neuromuscular assessment | Sonnet |

## What Makes This Different

**Not a chatbot.** ClinicalRounds runs a structured 4-stage clinical reasoning pipeline, not a single-prompt Q&A.

**Cross-consultation.** Specialists don't analyze in isolation. Hematology asks cardiology about anticoagulation risk in low-EF patients. Nephrology flags drug dosing concerns for pharmacy. Conflicts between specialists are surfaced, not hidden.

**Asks for missing data.** Specialists identify gaps in the clinical picture and generate targeted questions. Provide additional data and the entire team re-analyzes with the new information.

**Scoring systems.** Each specialist applies validated clinical scoring tools (HEART, Wells, MELD-Na, CURB-65, CHA2DS2-VASc, etc.) and shows their work.

**Problem-oriented output.** The final synthesis is organized by clinical problem with specialist-attributed recommendations -- ready to paste into an A/P section.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- An [Anthropic API key](https://console.anthropic.com/)

### Install and Run

```bash
# Clone the repository
git clone https://github.com/jeffbander/clinicalrounds.git
cd clinicalrounds

# Install dependencies
npm install

# Set your API key
cp .env.example .env.local
# Edit .env.local and add your ANTHROPIC_API_KEY

# Start the development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key from [console.anthropic.com](https://console.anthropic.com/) |

### API Key Cost

ClinicalRounds makes 11 parallel Claude API calls per case (9 specialists + intake parser + attending synthesis), plus cross-consultation rounds. A typical case review costs approximately $0.50-$2.00 in API usage depending on note length and complexity.

## Architecture

```
clinicalrounds/
├── app/
│   ├── api/
│   │   ├── analyze/          # Intake parsing + parallel specialist analysis (SSE)
│   │   ├── cross-consult/    # Inter-specialist Q&A routing
│   │   ├── synthesize/       # Attending synthesis (streaming)
│   │   ├── additional-data/  # Re-analysis with user-provided answers
│   │   └── health/           # Health check endpoint
│   ├── app/                  # Gated case-review tool (PasscodeGate + workflow)
│   └── page.tsx              # Public hero / landing page
├── components/               # React components
│   ├── ConferenceView.tsx    # Main case review interface
│   ├── SpecialistGrid.tsx    # Real-time specialist analysis cards
│   ├── TeamDiscussion.tsx    # Cross-consultation thread
│   ├── AssessmentPlan.tsx    # Final synthesized A/P
│   ├── PasteBox.tsx          # Clinical note input
│   ├── CriticalAlert.tsx     # Critical finding alerts
│   └── ui/                   # shadcn/ui primitives
├── lib/
│   ├── orchestrator.ts       # Multi-agent orchestration engine
│   ├── types.ts              # TypeScript interfaces
│   └── prompts/              # Specialist system prompts (clinical expertise)
│       ├── attending.ts
│       ├── cardiologist.ts
│       ├── pulmonologist.ts
│       ├── nephrologist.ts
│       ├── hepatologist.ts
│       ├── hematologist.ts
│       ├── id-specialist.ts
│       ├── radiologist.ts
│       ├── pharmacist.ts
│       ├── endocrinologist.ts
│       └── neurologist.ts
└── tests/                    # Vitest test suite
```

### Design Decisions

- **No database.** All state lives in React. Sessions are ephemeral. Close the tab and everything is gone.
- **No auth.** No user accounts, no login, no registration. Open and use.
- **No PHI storage.** Clinical text exists only in browser memory during the session. Nothing is logged, cached, or persisted.
- **Parallel execution.** All specialists run simultaneously via `Promise.all()`. No sequential bottleneck.
- **Streaming.** Both analysis and synthesis stream results via SSE for real-time UI updates.
- **Opus for synthesis, Sonnet for specialists.** The attending physician uses Opus for the final synthesis where reasoning quality matters most. All domain specialists use Sonnet for speed and cost efficiency.

### Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript (strict mode) |
| Frontend | React 19, Tailwind CSS, shadcn/ui, Radix UI |
| AI | Anthropic Claude API (Opus + Sonnet) |
| Testing | Vitest, Testing Library |
| Deployment | Vercel (or any Node.js host) |

## Development

```bash
# Run the dev server
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Lint
npm run lint

# Production build
npm run build
```

## Deployment

### Vercel (Recommended)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/jeffbander/clinicalrounds&env=ANTHROPIC_API_KEY&envDescription=Your%20Anthropic%20API%20key%20for%20Claude&project-name=clinicalrounds)

1. Click the button above or import the repo on [vercel.com](https://vercel.com)
2. Set `ANTHROPIC_API_KEY` in the environment variables
3. Deploy

The `vercel.json` is pre-configured with function timeouts (120s for analysis/synthesis, 60s for cross-consult).

### Self-Hosted

```bash
# Build for production
npm run build

# Start the production server
npm start
```

Set `ANTHROPIC_API_KEY` in your environment. The app runs on port 3000 by default.

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
ENV NODE_ENV=production
CMD ["npm", "start"]
```

```bash
docker build -t clinicalrounds .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=your-key-here clinicalrounds
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. Issues and pull requests are welcome.

## Clinical Disclaimer

ClinicalRounds is an AI clinical reasoning aid. It does not replace physician clinical judgment, formal specialist consultation, or the standard of care. AI-generated recommendations must be independently verified before any clinical application. This tool is not FDA-cleared and must not be used as a sole basis for diagnostic or treatment decisions. All patient care decisions remain the responsibility of the treating physician.

## License

[MIT](LICENSE)

---

Built by the [Agentic Laboratory](https://github.com/jeffbander) at Mount Sinai West.
