import {
  Stethoscope,
  Heart,
  Activity,
  Microscope,
  ShieldCheck,
  Zap,
  ClipboardCopy,
  FileText,
  Users,
  ArrowRight,
  Clock,
  Lock,
  Sparkles,
  AlertTriangle,
  Droplets,
  FlaskConical,
  Pill,
  ScanLine,
  CircleDot,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Disclaimer } from "@/components/Disclaimer"
import { APP_VERSION } from "@/lib/version"
import Link from "next/link"

const specialists = [
  {
    name: "Attending Hospitalist",
    icon: Stethoscope,
    expertise:
      "Systems-based assessment, medical decision-making, care coordination, risk stratification",
    color: "text-blue-600 bg-blue-50",
    model: "Opus",
  },
  {
    name: "Cardiology",
    icon: Heart,
    expertise:
      "Hemodynamic assessment, arrhythmia analysis, ACS evaluation, heart failure management",
    color: "text-red-600 bg-red-50",
    model: "Sonnet",
  },
  {
    name: "Pulm / Critical Care",
    icon: Activity,
    expertise:
      "Ventilator management, ABG interpretation, respiratory failure, ARDS protocols",
    color: "text-sky-600 bg-sky-50",
    model: "Sonnet",
  },
  {
    name: "Nephrology",
    icon: Droplets,
    expertise:
      "Electrolyte disorders, AKI staging, dialysis assessment, acid-base analysis",
    color: "text-amber-600 bg-amber-50",
    model: "Sonnet",
  },
  {
    name: "Hepatology",
    icon: CircleDot,
    expertise:
      "Liver function assessment, cirrhosis management, MELD scoring, hepatic encephalopathy",
    color: "text-yellow-600 bg-yellow-50",
    model: "Sonnet",
  },
  {
    name: "Hematology",
    icon: FlaskConical,
    expertise:
      "Coagulopathy workup, transfusion thresholds, anticoagulation management, DIC evaluation",
    color: "text-rose-600 bg-rose-50",
    model: "Sonnet",
  },
  {
    name: "Infectious Disease",
    icon: Microscope,
    expertise:
      "Antimicrobial stewardship, culture interpretation, empiric coverage, de-escalation",
    color: "text-green-600 bg-green-50",
    model: "Sonnet",
  },
  {
    name: "Radiology",
    icon: ScanLine,
    expertise:
      "Imaging correlation, incidental findings, follow-up recommendations, modality guidance",
    color: "text-indigo-600 bg-indigo-50",
    model: "Sonnet",
  },
  {
    name: "Pharmacy",
    icon: Pill,
    expertise:
      "Drug interactions, renal/hepatic dosing, medication reconciliation, IV compatibility",
    color: "text-teal-600 bg-teal-50",
    model: "Sonnet",
  },
]

const steps = [
  {
    number: "1",
    title: "Paste Your Note",
    description:
      "Copy any clinical note from Epic -- H&P, progress note, consult, or discharge summary. No login. No EHR integration. Just paste.",
    icon: FileText,
  },
  {
    number: "2",
    title: "9 Specialists Analyze",
    description:
      "All 9 AI specialists review simultaneously from their domain perspective. They cross-consult each other and flag critical findings. They ask you for missing data.",
    icon: Users,
  },
  {
    number: "3",
    title: "Copy the A/P",
    description:
      "Get a unified Assessment & Plan organized by problem, with specialist-attributed recommendations, scoring systems, and guidelines cited. One-click copy.",
    icon: ClipboardCopy,
  },
]

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <Stethoscope className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="text-lg font-semibold tracking-tight">
              ClinicalRounds
            </span>
          </div>

          <div className="hidden items-center gap-6 sm:flex">
            <a
              href="#how-it-works"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              How It Works
            </a>
            <a
              href="#specialists"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              The Team
            </a>
            <a
              href="#why"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Why This
            </a>
          </div>

          <Link href="/app">
            <Button size="sm">
              Start Review
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden border-b bg-gradient-to-b from-background via-primary/5 to-background">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,theme(colors.primary/12),transparent_60%)]"
        />
        <div className="relative mx-auto max-w-5xl px-4 py-20 sm:px-6 sm:py-28">
          <div className="mx-auto max-w-3xl text-center">
            <Badge variant="secondary" className="mb-6 gap-1.5">
              <Lock className="h-3 w-3" />
              No PHI stored. No account required.
            </Badge>

            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
              Instant AI Multidisciplinary
              <br />
              Case Review
            </h1>

            <p className="mt-6 text-lg leading-relaxed text-muted-foreground sm:text-xl">
              Paste an Epic note. 9 AI specialists analyze in parallel,
              cross-consult each other, and synthesize a unified Assessment
              &amp; Plan organized by problem.
            </p>

            <div className="mt-8 flex flex-col items-center gap-2 sm:flex-row sm:justify-center sm:gap-4">
              <Link href="/app">
                <Button size="lg" className="w-full sm:w-auto">
                  <Sparkles className="mr-2 h-4 w-4" />
                  Start a Case Review
                </Button>
              </Link>
              <a href="#how-it-works">
                <Button
                  variant="ghost"
                  size="lg"
                  className="w-full text-muted-foreground sm:w-auto"
                >
                  See How It Works
                </Button>
              </a>
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Results in ~30 seconds
              </span>
              <span className="flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5" />
                Zero data retention
              </span>
              <span className="flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5" />
                No EHR integration needed
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Problem Statement */}
      <section className="border-b bg-muted/30">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-3xl">
            <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
              Complex patients need more than a single perspective
            </h2>
            <p className="mt-4 text-center text-muted-foreground">
              Your ICU patient has acute-on-chronic systolic heart failure,
              AKI on CKD, supratherapeutic INR, and a rising lactate. A real
              multidisciplinary team review means coordinating cardiology,
              nephrology, hematology, pharmacy, and more -- days of
              scheduling, hours of rounding. Most patients never get one.
            </p>

            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              <div className="rounded-lg border bg-card p-4 text-center">
                <div className="text-2xl font-bold text-foreground">72%</div>
                <p className="mt-1 text-sm text-muted-foreground">
                  of hospitalists report inadequate specialist access for
                  complex cases
                </p>
              </div>
              <div className="rounded-lg border bg-card p-4 text-center">
                <div className="text-2xl font-bold text-foreground">
                  3-5 days
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  average wait for a formal multidisciplinary case conference
                </p>
              </div>
              <div className="rounded-lg border bg-card p-4 text-center">
                <div className="text-2xl font-bold text-foreground">
                  ~30 sec
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  for ClinicalRounds to deliver 9 specialist perspectives
                  with cross-consultation
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="border-b">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
          <div className="text-center">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Three steps. Thirty seconds.
            </h2>
            <p className="mt-3 text-muted-foreground">
              No setup, no integration, no learning curve.
            </p>
          </div>

          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {steps.map((step) => (
              <div key={step.number} className="relative">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                    {step.number}
                  </div>
                  <div>
                    <h3 className="font-semibold">{step.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                      {step.description}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Visual: Mock interface */}
          <div className="mx-auto mt-12 max-w-2xl">
            <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
                <div className="h-2.5 w-2.5 rounded-full bg-red-400" />
                <div className="h-2.5 w-2.5 rounded-full bg-yellow-400" />
                <div className="h-2.5 w-2.5 rounded-full bg-green-400" />
                <span className="ml-3 font-mono text-xs text-muted-foreground">
                  ClinicalRounds
                </span>
              </div>

              <div className="p-4">
                <div className="rounded-lg border border-dashed border-muted-foreground/25 bg-muted/20 p-4">
                  <p className="font-mono text-xs leading-relaxed text-muted-foreground">
                    72M w/ PMHx CHF (EF 25%), CKD3, DM2, afib on warfarin.
                    Admitted for acute on chronic systolic HF exacerbation.
                    On IV furosemide gtt, I/Os trending negative. Cr 2.1
                    (baseline 1.6). INR 3.8. BNP 4200. Lactate 2.4. WBC
                    11.2. Na 131. K 5.1...
                  </p>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="rounded-md bg-red-50 p-2 text-center">
                    <div className="text-[10px] font-medium text-red-700">
                      Cardiology
                    </div>
                    <div className="mt-0.5 h-1.5 w-full rounded-full bg-red-200">
                      <div className="h-full w-4/5 rounded-full bg-red-500" />
                    </div>
                  </div>
                  <div className="rounded-md bg-amber-50 p-2 text-center">
                    <div className="text-[10px] font-medium text-amber-700">
                      Nephrology
                    </div>
                    <div className="mt-0.5 h-1.5 w-full rounded-full bg-amber-200">
                      <div className="h-full w-3/5 rounded-full bg-amber-500" />
                    </div>
                  </div>
                  <div className="rounded-md bg-rose-50 p-2 text-center">
                    <div className="text-[10px] font-medium text-rose-700">
                      Hematology
                    </div>
                    <div className="mt-0.5 h-1.5 w-full rounded-full bg-rose-200">
                      <div className="h-full w-full rounded-full bg-rose-500" />
                    </div>
                  </div>
                </div>

                <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2">
                  <p className="text-[10px] font-medium text-amber-800">
                    Cross-consult: Hematology to Cardiology
                  </p>
                  <p className="text-[10px] text-amber-700">
                    &ldquo;INR 3.8 with EF 25% -- recommend hold warfarin,
                    vitamin K 2.5mg PO, recheck INR in 6h before resuming
                    anticoagulation&rdquo;
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Analysis Pipeline Detail */}
      <section className="border-b bg-muted/30">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
          <div className="text-center">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              More than a chatbot
            </h2>
            <p className="mt-3 text-muted-foreground">
              ClinicalRounds runs a structured 4-stage clinical reasoning
              pipeline -- not a single prompt.
            </p>
          </div>

          <div className="mx-auto mt-10 max-w-2xl">
            <div className="relative space-y-0">
              {[
                {
                  stage: "Intake Parsing",
                  detail:
                    "Raw note is parsed into structured data: demographics, vitals, labs, meds, imaging, PMH, allergies. Missing data is identified.",
                  model: "Sonnet",
                },
                {
                  stage: "Parallel Specialist Analysis",
                  detail:
                    "All 9 specialists analyze simultaneously via Promise.all(). Each generates findings, concerns (severity-graded), recommendations (priority-ranked), scoring systems, and cross-consult requests.",
                  model: "Sonnet + Opus",
                },
                {
                  stage: "Cross-Consultation",
                  detail:
                    "Specialists respond to each other's questions. Hematology asks cardiology about anticoagulation risk. Nephrology flags drug dosing for pharmacy. Conflicts are surfaced.",
                  model: "Sonnet",
                },
                {
                  stage: "Synthesis",
                  detail:
                    "The attending synthesizes all analyses into a problem-oriented A/P with guideline citations, specialist attribution, and confidence levels. Streamed in real-time.",
                  model: "Opus",
                },
              ].map((item, i) => (
                <div key={item.stage} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-primary text-xs font-bold text-primary-foreground">
                      {i + 1}
                    </div>
                    {i < 3 && (
                      <div className="h-full w-px bg-border" />
                    )}
                  </div>
                  <div className="pb-8">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">
                        {item.stage}
                      </h3>
                      <Badge variant="outline" className="text-[10px]">
                        {item.model}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {item.detail}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Specialist Team */}
      <section id="specialists" className="border-b">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
          <div className="text-center">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Your AI Multidisciplinary Team
            </h2>
            <p className="mt-3 text-muted-foreground">
              9 specialists analyze simultaneously, cross-consult each
              other, and flag issues a single reviewer might miss.
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {specialists.map((specialist) => (
              <Card key={specialist.name} className="gap-3 py-4">
                <CardHeader className="pb-0">
                  <div className="flex items-center gap-3">
                    <div
                      className={`flex h-9 w-9 items-center justify-center rounded-lg ${specialist.color}`}
                    >
                      <specialist.icon className="h-4 w-4" />
                    </div>
                    <div>
                      <CardTitle className="text-sm">
                        {specialist.name}
                      </CardTitle>
                      <span className="text-[10px] text-muted-foreground">
                        Claude {specialist.model}
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {specialist.expertise}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Why ClinicalRounds */}
      <section id="why" className="border-b">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
          <div className="text-center">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Why this works
            </h2>
            <p className="mt-3 text-muted-foreground">
              Not an EHR. Not a chatbot. Not a documentation tool.
              ClinicalRounds does one thing: multidisciplinary case review.
            </p>
          </div>

          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border bg-card p-5">
              <Lock className="mb-3 h-5 w-5 text-muted-foreground" />
              <h3 className="font-semibold">Zero PHI Storage</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Notes are processed in-memory by the Claude API and
                discarded after the response. Nothing is logged, stored,
                cached, or retained anywhere.
              </p>
            </div>

            <div className="rounded-lg border bg-card p-5">
              <Zap className="mb-3 h-5 w-5 text-muted-foreground" />
              <h3 className="font-semibold">No EHR Integration</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                No FHIR. No HL7. No IT tickets. No API keys to configure.
                Copy-paste from Epic and get results. Works alongside any
                EHR.
              </p>
            </div>

            <div className="rounded-lg border bg-card p-5">
              <Users className="mb-3 h-5 w-5 text-muted-foreground" />
              <h3 className="font-semibold">Real Cross-Consultation</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Specialists don&apos;t just analyze in isolation. They
                cross-consult each other -- hematology asks cardiology about
                anticoagulation, nephrology flags drug dosing for pharmacy.
              </p>
            </div>

            <div className="rounded-lg border bg-card p-5">
              <ShieldCheck className="mb-3 h-5 w-5 text-muted-foreground" />
              <h3 className="font-semibold">No Account Required</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                No registration, no login, no profile. Open the tool and
                start immediately. Sessions are ephemeral -- close the tab
                and everything is gone.
              </p>
            </div>

            <div className="rounded-lg border bg-card p-5">
              <Sparkles className="mb-3 h-5 w-5 text-muted-foreground" />
              <h3 className="font-semibold">Asks for Missing Data</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                Specialists identify gaps in the clinical picture and ask
                you targeted questions. Provide additional data and get
                refined recommendations.
              </p>
            </div>

            <div className="rounded-lg border bg-card p-5">
              <ClipboardCopy className="mb-3 h-5 w-5 text-muted-foreground" />
              <h3 className="font-semibold">Problem-Based A/P</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                The final synthesis is organized by problem with
                specialist-attributed recommendations, scoring systems, and
                guideline citations. Copy directly into your note.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Who Uses It */}
      <section className="border-b bg-muted/30">
        <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6">
          <div className="mx-auto max-w-3xl text-center">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Built for inpatient medicine
            </h2>
            <p className="mt-3 text-muted-foreground">
              ClinicalRounds is designed for physicians managing complex,
              multi-system inpatients.
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border bg-card p-5 text-center">
              <Stethoscope className="mx-auto mb-3 h-6 w-6 text-primary" />
              <h3 className="font-semibold">Hospitalists</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Managing 15-20 inpatients daily across multiple organ
                systems with limited specialist availability, especially
                overnight and on weekends.
              </p>
            </div>
            <div className="rounded-lg border bg-card p-5 text-center">
              <Activity className="mx-auto mb-3 h-6 w-6 text-primary" />
              <h3 className="font-semibold">ICU Teams</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Critical care physicians with multi-organ failure patients
                who need rapid cross-specialty input for ventilator, renal,
                cardiac, and infectious management.
              </p>
            </div>
            <div className="rounded-lg border bg-card p-5 text-center">
              <ShieldCheck className="mx-auto mb-3 h-6 w-6 text-primary" />
              <h3 className="font-semibold">Fellows &amp; Attendings</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Building clinical reasoning or validating plans against
                multi-specialty perspectives before rounds, especially for
                unfamiliar presentations.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-b">
        <div className="mx-auto max-w-5xl px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Try it now. No signup.
            </h2>
            <p className="mt-4 text-muted-foreground">
              Paste any clinical note and get a full multidisciplinary case
              review in under a minute.
            </p>
            <div className="mt-8">
              <Link href="/app">
                <Button size="lg">
                  <Sparkles className="mr-2 h-4 w-4" />
                  Start Your First Case Review
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Clinical Disclaimer */}
      <section className="bg-muted/50">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <div className="mx-auto max-w-3xl">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
                <div>
                  <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-200">
                    Clinical Disclaimer
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
                    ClinicalRounds is an AI clinical reasoning aid. It does
                    not replace physician clinical judgment, formal
                    specialist consultation, or the standard of care.
                    AI-generated recommendations must be independently
                    verified before any clinical application. This tool is
                    not FDA-cleared and must not be used as a sole basis
                    for diagnostic or treatment decisions. All patient care
                    decisions remain the responsibility of the treating
                    physician. No data is stored -- all clinical text
                    exists only in browser memory during the session.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded bg-primary">
                <Stethoscope className="h-3 w-3 text-primary-foreground" />
              </div>
              <span className="text-sm font-medium">ClinicalRounds</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Built by the Agentic Laboratory at Mount Sinai West. &nbsp;{APP_VERSION}
            </p>
          </div>
          <div className="mt-3">
            <Disclaimer />
          </div>
        </div>
      </footer>
    </div>
  )
}
