export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type AnalysisStatus = 'waiting' | 'analyzing' | 'complete' | 'critical';

export enum Specialist {
  ATTENDING = 'attending',
  CARDIOLOGIST = 'cardiologist',
  PULMONOLOGIST = 'pulmonologist',
  NEPHROLOGIST = 'nephrologist',
  HEPATOLOGIST = 'hepatologist',
  HEMATOLOGIST = 'hematologist',
  ID_SPECIALIST = 'id_specialist',
  RADIOLOGIST = 'radiologist',
  PHARMACIST = 'pharmacist',
  ENDOCRINOLOGIST = 'endocrinologist',
  NEUROLOGIST = 'neurologist',
  INTENSIVIST = 'intensivist',
  ONCOLOGIST = 'oncologist',
  PSYCHIATRIST = 'psychiatrist',
  TOXICOLOGIST = 'toxicologist',
  PALLIATIVE = 'palliative',
}

export const SPECIALIST_CONFIG: Record<Specialist, { name: string; icon: string; model: 'sonnet' | 'opus' }> = {
  [Specialist.ATTENDING]: { name: 'Attending', icon: '\u{1F468}\u200D\u2695\uFE0F', model: 'opus' },
  [Specialist.CARDIOLOGIST]: { name: 'Cardiology', icon: '\u2764\uFE0F', model: 'sonnet' },
  [Specialist.PULMONOLOGIST]: { name: 'Pulm/CC', icon: '\u{1FAC1}', model: 'sonnet' },
  [Specialist.NEPHROLOGIST]: { name: 'Nephrology', icon: '\u{1F9EA}', model: 'sonnet' },
  [Specialist.HEPATOLOGIST]: { name: 'Hepatology', icon: '\u{1F7E1}', model: 'sonnet' },
  [Specialist.HEMATOLOGIST]: { name: 'Hematology', icon: '\u{1FA78}', model: 'sonnet' },
  [Specialist.ID_SPECIALIST]: { name: 'ID', icon: '\u{1F9A0}', model: 'sonnet' },
  [Specialist.RADIOLOGIST]: { name: 'Radiology', icon: '\u{1F4E1}', model: 'sonnet' },
  [Specialist.PHARMACIST]: { name: 'Pharmacy', icon: '\u{1F48A}', model: 'sonnet' },
  [Specialist.ENDOCRINOLOGIST]: { name: 'Endocrinology', icon: '\u{1F9EC}', model: 'sonnet' },
  [Specialist.NEUROLOGIST]: { name: 'Neurology', icon: '\u{1F9E0}', model: 'sonnet' },
  [Specialist.INTENSIVIST]: { name: 'Critical Care', icon: '🏥', model: 'sonnet' },
  [Specialist.ONCOLOGIST]: { name: 'Oncology', icon: '🎗️', model: 'sonnet' },
  [Specialist.PSYCHIATRIST]: { name: 'Psychiatry', icon: '🧩', model: 'sonnet' },
  [Specialist.TOXICOLOGIST]: { name: 'Toxicology', icon: '☠️', model: 'sonnet' },
  [Specialist.PALLIATIVE]: { name: 'Palliative Care', icon: '🕊️', model: 'sonnet' },
};

export interface Concern {
  severity: Severity;
  detail: string;
}

export interface Recommendation {
  priority: string;
  recommendation: string;
  rationale: string;
  evidence_basis: string | null;
}

export interface CrossConsultRequest {
  to: string;
  question: string;
}

export interface ScoringSystem {
  name: string;
  score: number | string;
  interpretation: string;
}

export interface WebSearchCitation {
  title: string;
  url: string;
  page_age?: string;
}

export interface SpecialistSearchActivity {
  specialist: string;
  query: string;
  citations: WebSearchCitation[];
  timestamp: number;
}

export interface SpecialistCalculationActivity {
  specialist: string;
  code: string;
  result: string;
  success: boolean;
  timestamp: number;
}

export interface SpecialistAnalysis {
  specialist: Specialist;
  findings: string[];
  concerns: Concern[];
  recommendations: Recommendation[];
  questions_for_user: string[];
  questions_for_team: string[];
  cross_consults: CrossConsultRequest[];
  scoring_systems_applied: ScoringSystem[];
  web_search_citations?: WebSearchCitation[];
  calculations_performed?: SpecialistCalculationActivity[];
}

export interface IntakeData {
  demographics: {
    age?: number;
    sex?: string;
    weight?: number;
    height?: number;
  };
  chief_complaint: string;
  hpi: string;
  past_medical_history: string[];
  medications: Array<{
    name: string;
    dose?: string;
    route?: string;
    frequency?: string;
    type: 'home' | 'inpatient';
  }>;
  allergies: string[];
  vitals: {
    hr?: number;
    bp_systolic?: number;
    bp_diastolic?: number;
    rr?: number;
    temp?: number;
    spo2?: number;
    trends?: string;
  };
  labs: Array<{
    name: string;
    value: string;
    unit?: string;
    reference_range?: string;
    timestamp?: string;
    abnormal?: boolean;
  }>;
  imaging: Array<{
    modality: string;
    findings: string;
    timestamp?: string;
  }>;
  ecg?: string;
  physical_exam: string;
  procedures_consults: string[];
  missing_data: string[];
  raw_text: string;
}

export interface CrossConsultMessage {
  from: Specialist;
  to: Specialist;
  message: string;
  response?: string;
}

export interface DiscussionMessage {
  specialist: string;
  content: string;
  timestamp: number;
}

export interface UserQuestion {
  id: string;
  specialist: string;
  question: string;
  answer?: string | null;
}

// ─── Temporal / Encounter Types ───────────────────────────────────────────────

export interface ClinicalEncounter {
  id: string;
  date: string;
  encounter_type: string;
  labs: IntakeData['labs'];
  vitals: IntakeData['vitals'];
  imaging: IntakeData['imaging'];
  notes: string;
  procedures_consults: string[];
}

export interface TemporalIntakeData extends IntakeData {
  encounters: ClinicalEncounter[];
  timeline_summary: string;
  date_range: { start: string; end: string };
}

// ─── Multi-Round Cross-Consult Types ─────────────────────────────────────────

export interface CrossConsultRound {
  round: number;
  messages: CrossConsultMessage[];
}

export interface CrossConsultMessageV2 extends CrossConsultMessage {
  round: number;
  response_questions?: string[];
  thread_id?: string;
}

// ─── Specialist Chat Types ───────────────────────────────────────────────────

export interface SpecialistChatMessage {
  id: string;
  role: 'user' | 'specialist';
  specialist?: Specialist;
  content: string;
  timestamp: number;
  triggered_discussions?: CrossConsultMessage[];
}

// ─── Discussion Pause / User Steering Types ──────────────────────────────────

export interface DiscussionPauseState {
  roundsCompleted: number;
  pendingQuestions: string[];
  canContinue: boolean;
}

export interface UserSteeringAction {
  type: 'continue' | 'ask_specialist' | 'inject_hypothesis' | 'proceed_to_synthesis';
  specialist?: Specialist;
  question?: string;
  additionalRounds?: number;
}

// ─── Case State ──────────────────────────────────────────────────────────────

export interface CaseState {
  step: 'idle' | 'parsing' | 'analyzing' | 'cross_consulting' | 'synthesizing' | 'complete' | 'discussion_paused' | 'chatting';
  rawNotes: string;
  intakeData: IntakeData | null;
  parseReport: ParseReport | null;
  specialistAnalyses: Record<string, SpecialistAnalysis>;
  specialistStatuses: Record<string, AnalysisStatus>;
  crossConsultMessages: CrossConsultMessage[];
  crossConsultRounds: CrossConsultRound[];
  currentRound: number;
  maxRounds: number;
  chatHistory: SpecialistChatMessage[];
  discussionThread: DiscussionMessage[];
  userAnswers: Record<string, string | null>;
  pendingQuestions: UserQuestion[];
  synthesizedPlan: string;
  isStreaming: boolean;
  criticalAlerts: Array<{ specialist: string; detail: string }>;
  scoringSystems: ScoringSystem[];
  tokenUsage: { input: number; output: number; estimatedCost: number };
  error: string | null;
  webSearchEnabled: boolean;
  searchActivities: SpecialistSearchActivity[];
  calculationActivities: SpecialistCalculationActivity[];
}

// ─── Parse Stage Types ──────────────────────────────────────────────────────
// Universal note intake — clean and structure raw Epic copy-paste before
// the 9-specialist pipeline runs. See /lib/parse/ and /docs/parsing.md.

export type SectionKey =
  | 'chief_complaint'
  | 'hpi'
  | 'pmh'
  | 'psh'
  | 'medications'
  | 'allergies'
  | 'social_history'
  | 'family_history'
  | 'vitals'
  | 'physical_exam'
  | 'labs'
  | 'imaging'
  | 'assessment_plan'
  | 'other';

export type ParseConfidence = 'high' | 'medium' | 'low';

export type ParserProvider = 'anthropic' | 'mistral' | 'none';

export interface ParseCleaningReport {
  charsStripped: number;
  quotesFolded: number;
  pageBreaksRemoved: number;
  sectionsFound: number;
  usedLLM: boolean;
  parserProvider: ParserProvider;
  truncated?: boolean;
  latencyMs?: number;
}

export interface ParsedClinicalNote {
  raw: string;
  normalized: string;
  sections: Partial<Record<SectionKey, string>>;
  warnings: string[];
  confidence: ParseConfidence;
  cleaningReport: ParseCleaningReport;
}

// API request/response types
export interface AnalyzeRequest {
  rawNotes: string;
  webSearchEnabled?: boolean;
}

export interface AnalyzeResponse {
  intakeData: IntakeData;
  specialistAnalyses: Record<string, SpecialistAnalysis>;
  discussionMessages: DiscussionMessage[];
}

export interface CrossConsultApiRequest {
  analyses: Record<string, SpecialistAnalysis>;
  intakeData: IntakeData;
}

export interface CrossConsultResponse {
  messages: CrossConsultMessage[];
  updatedAnalyses: Record<string, SpecialistAnalysis>;
  discussionMessages: DiscussionMessage[];
}

export interface AdditionalDataRequest {
  answers: Record<string, string | null>;
  previousAnalyses: Record<string, SpecialistAnalysis>;
  intakeData: IntakeData;
}

export interface AdditionalDataResponse {
  updatedAnalyses: Record<string, SpecialistAnalysis>;
  discussionMessages: DiscussionMessage[];
}

export interface SynthesizeRequest {
  analyses: Record<string, SpecialistAnalysis>;
  crossConsults: CrossConsultMessage[];
  intakeData: IntakeData;
}

// SSE event types for streaming pipeline progress

export interface ParseReport {
  confidence: ParseConfidence;
  sectionsFound: number;
  usedLLM: boolean;
  parserProvider: ParserProvider;
  charsStripped: number;
  quotesFolded: number;
  pageBreaksRemoved: number;
  truncated?: boolean;
  latencyMs?: number;
  warnings: string[];
}

export type AnalyzeSSEEvent =
  | { type: 'parse_complete'; parseReport: ParseReport }
  | { type: 'intake_complete'; intakeData: IntakeData; sanitizationWarnings?: string[] }
  | { type: 'triage_complete'; selectedSpecialists: Specialist[]; skippedSpecialists: Specialist[]; reasoning: string }
  | { type: 'specialist_complete'; specialist: Specialist; analysis: SpecialistAnalysis; discussionMessage: DiscussionMessage }
  | { type: 'specialist_error'; specialist: Specialist; error: string }
  | { type: 'specialist_search'; specialist: string; query: string }
  | { type: 'specialist_calculation'; specialist: string; code: string }
  | { type: 'analyze_done'; totalSpecialists: number; completedCount: number };

export type CrossConsultSSEEvent =
  | { type: 'cross_consult_message'; message: CrossConsultMessage; discussionMessage: DiscussionMessage }
  | { type: 'cross_consult_done'; totalExchanges: number; completedCount: number };

// ─── Multi-Round Cross-Consult SSE Events ────────────────────────────────────

export type MultiRoundCrossConsultSSEEvent =
  | { type: 'round_start'; round: number; totalRounds: number }
  | { type: 'cross_consult_message'; message: CrossConsultMessageV2; discussionMessage: DiscussionMessage; round: number }
  | { type: 'round_done'; round: number; messagesInRound: number }
  | { type: 'all_rounds_complete'; totalRounds: number; totalMessages: number }
  | { type: 'discussion_paused'; pauseState: DiscussionPauseState };

// ─── Specialist Chat SSE Events ──────────────────────────────────────────────

export type SpecialistChatSSEEvent =
  | { type: 'chat_response'; message: SpecialistChatMessage }
  | { type: 'chat_triggered_discussion'; discussions: CrossConsultMessage[] }
  | { type: 'chat_done' };

// ─── Append Notes API Types ──────────────────────────────────────────────────

export interface AppendNotesRequest {
  additionalNotes: string;
  existingIntakeData: IntakeData;
  existingAnalyses: Record<string, SpecialistAnalysis>;
}

export interface AppendNotesResponse {
  updatedIntakeData: IntakeData;
  updatedAnalyses: Record<string, SpecialistAnalysis>;
  discussionMessages: DiscussionMessage[];
}

// ─── Specialist Chat API Types ───────────────────────────────────────────────

export interface SpecialistChatRequest {
  specialist: Specialist;
  message: string;
  chatHistory: SpecialistChatMessage[];
  intakeData: IntakeData;
  analyses: Record<string, SpecialistAnalysis>;
  crossConsults: CrossConsultMessage[];
}

export interface SpecialistChatResponse {
  response: SpecialistChatMessage;
  triggeredDiscussions?: CrossConsultMessage[];
}

// ─── Presentation Types ─────────────────────────────────────────────────────

export interface PresentationRequest {
  intakeData: IntakeData;
  specialistAnalyses: Record<string, SpecialistAnalysis>;
  crossConsultMessages: CrossConsultMessage[];
  synthesizedPlan: string;
  criticalAlerts: Array<{ specialist: string; detail: string }>;
  scoringSystems: ScoringSystem[];
  options: {
    type: string;
    audience?: string;
    focusAreas?: string[];
  };
}

export interface PresentationResponse {
  outline: string;
  gammaUrl?: string;
  generationId?: string;
}
