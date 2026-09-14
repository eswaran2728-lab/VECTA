/**
 * W.O.I.S Intelligence Engine (Work Order Intelligence Smartbook)
 * RAG Knowledge Retrieval, Precedence Reasoning, Safety Guard & Confidence Classifier.
 */

import type {
  WoisConfidenceTag,
  WoisEngineResponse,
  WoisSourceCitation,
  WoisSourceType,
} from "@/lib/avsec/types";
import { WOIS_KNOWLEDGE_DOCUMENTS } from "./knowledge/wois-data.ts";

export interface UserContext {
  userId?: string;
  role?: string | null;
  ops_group?: string | null;
  station?: string | null;
  team?: string | null;
}

// 1. Incident Escalation Keywords
const ESCALATION_TRIGGERS = [
  "bomb threat",
  "hijack",
  "active shooter",
  "weapon on board",
  "gun on board",
  "cockpit breach",
  "flight deck breach",
  "physical fight in progress",
  "hostage",
  "knife attack",
  "explosive device found",
  "active fire on ramp",
  "unattended suspicious bag ticking",
];

// 2. Full Document Request Triggers
const FULL_DOC_TRIGGERS = [
  "give me w.o.i.s",
  "give me wois",
  "show wois",
  "show w.o.i.s",
  "what is wois",
  "what is w.o.i.s",
  "wois manual",
  "w.o.i.s manual",
  "full sop",
  "sop manual",
  "full document",
  "whole document",
  "wois document",
];

// 3. Hierarchy Disclosure Deflection Triggers
const HIERARCHY_PROBES = [
  "role hierarchy",
  "who reports to whom",
  "who is above whom",
  "rank order",
  "who supervises",
  "what can management do that i cannot",
  "what permissions does so have",
  "reporting structure of vecta",
];

/**
 * Execute W.O.I.S Intelligence Query
 */
const ADMIN_POLICY_TRIGGERS = [
  "per diem",
  "salary",
  "uniform claim",
  "hotel claim",
  "hotel allowance",
  "outstation allowance",
  "mileage claim",
];

// Bare greetings/small talk carry no operational content — answer them directly instead
// of falling through to the "insufficient information" catch-all, which reads as broken
// for the first message a staff member ever sends the assistant.
const GREETING_PATTERNS = [
  "hi",
  "hello",
  "hey",
  "yo",
  "hai",
  "good morning",
  "good afternoon",
  "good evening",
  "morning",
  "afternoon",
  "evening",
  "thanks",
  "thank you",
  "ok",
  "okay",
  "test",
];

export async function executeWoisQuery(
  query: string,
  userContext: UserContext = {}
): Promise<WoisEngineResponse> {
  const normalizedQuery = query.toLowerCase().trim();

  // Safety Policy 1: Immediate Security / Incident Escalation
  if (isEscalationTriggered(normalizedQuery)) {
    return handleEscalation(query);
  }

  if (isGreeting(normalizedQuery)) {
    return handleGreeting();
  }

  // Safety Policy 2: Strict Role Hierarchy Non-Disclosure Deflection
  if (isHierarchyProbe(normalizedQuery)) {
    return handleHierarchyDeflection();
  }

  // Feature: Full-Document Retrieval Intent Short-Circuit
  if (isFullDocumentRequest(normalizedQuery)) {
    return handleFullDocumentRetrieval();
  }

  // Missing Administrative Policy Handler
  if (isMissingPolicyProbe(normalizedQuery)) {
    return handleRequiresSop();
  }

  // RAG Search & Chunk Retrieval
  const searchResults = searchKnowledgeBase(normalizedQuery, userContext);

  if (searchResults.length === 0) {
    // Check if it's general aviation knowledge vs completely unknown/uncertain
    return handleFallbackReasoning(normalizedQuery, userContext);
  }

  // Ambiguity Guard: a low-confidence top match, or a close second match on
  // a genuinely different topic, means guessing is more likely to give a
  // confident-but-wrong answer than to help — ask which one they meant
  // instead of silently picking one.
  const ambiguous = detectAmbiguity(searchResults);
  if (ambiguous) {
    return handleAmbiguousQuery(ambiguous);
  }

  // Primary Matched Result from Knowledge Base
  const topMatch = searchResults[0];
  const citations: WoisSourceCitation[] = searchResults.slice(0, 3).map((r) => ({
    documentTitle: r.docTitle,
    sectionTitle: r.chunk.section_title,
    pageNumber: r.chunk.page_number,
    sourceType: r.source_type,
    excerpt: r.chunk.content,
    version: r.version,
    lastReviewed: r.last_reviewed,
  }));

  // Handle App Help Direct Answers
  if (topMatch.source_type === "app_help") {
    return handleAppHelpResponse(normalizedQuery, topMatch, citations, userContext);
  }

  // Handle Substantive Operational Questions (SOP & Regulatory)
  return handleOperationalResponse(normalizedQuery, topMatch, citations, userContext);
}

export function isEscalationTriggered(query: string): boolean {
  return ESCALATION_TRIGGERS.some((trigger) => query.includes(trigger));
}

export function isGreeting(query: string): boolean {
  const stripped = query.replace(/[^a-z\s]/g, "").trim();
  if (stripped.length === 0) return false;
  // Only short messages — "hi" matches, "hi what is the search timing" should not.
  if (stripped.split(/\s+/).length > 3) return false;
  return GREETING_PATTERNS.some((g) => stripped === g || stripped.startsWith(g + " "));
}

function handleGreeting(): WoisEngineResponse {
  return {
    body: `Hi, I'm W.O.I.S — your operational assistant for SOPs, dangerous goods limits, and VECTA app help.

Ask me something like:
- "What is the minimum aircraft search timing for an A330?"
- "Can a 20,000mAh power bank board in carry-on baggage?"
- "How do I submit an Overtime (OT) request?"`,
    confidence_tag: "GENERAL_KNOWLEDGE",
    source_type: "general",
    sources: [],
  };
}

export function isHierarchyProbe(query: string): boolean {
  return HIERARCHY_PROBES.some((probe) => query.includes(probe));
}

export function isFullDocumentRequest(query: string): boolean {
  return FULL_DOC_TRIGGERS.some((t) => query.includes(t)) || query === "wois" || query === "w.o.i.s";
}

function isMissingPolicyProbe(query: string): boolean {
  return ADMIN_POLICY_TRIGGERS.some((t) => query.includes(t));
}

function handleRequiresSop(): WoisEngineResponse {
  return {
    body: `That's a company-specific administrative question and I don't have that policy in my knowledge base — best to check with your Duty Security Executive (DSE) or station management directly.`,
    confidence_tag: "REQUIRES_SOP",
    source_type: "general",
    sources: [],
  };
}

export function handleEscalation(query: string): WoisEngineResponse {
  const body = `🚨 This isn't something to work through here — "${query}" describes an active high-risk safety or security emergency. Stop and act now:

1. Don't try to resolve this via Q&A or documentation.
2. Immediately notify your Duty Security Executive (DSE), Security Officer (SO), and Enforcement.
3. In-flight or cabin incident — notify the Pilot-in-Command (PIC) immediately.
4. Terminal or ramp security threat — contact Airport Police and activate local emergency response.
5. Once contained, file a mandatory SEC 014 Incident Report in VECTA.`;

  return {
    body,
    confidence_tag: "ESCALATE",
    source_type: "sop",
    sources: [
      {
        documentTitle: "Emergency Response & Escalation Protocol",
        sectionTitle: "Live Security Threat Escalation",
        sourceType: "sop",
      },
    ],
  };
}

export function handleHierarchyDeflection(): WoisEngineResponse {
  return {
    body: `That's not something I go into — I'm here for SOPs, dangerous goods limits, security screening, and VECTA app features, not departmental structure. For anything about role hierarchy or reporting lines, check with your Duty Security Executive (DSE).`,
    confidence_tag: "GENERAL_KNOWLEDGE",
    source_type: "general",
    sources: [],
  };
}

export function handleFullDocumentRetrieval(): WoisEngineResponse {
  const doc = WOIS_KNOWLEDGE_DOCUMENTS.find((d) => d.id === "doc-wois-sop-manual")!;
  const attachment = doc.file_url
    ? {
        filename: "W_O_I_S.pdf",
        title: "AirAsia AVSEC W.O.I.S SOP Manual (PDF)",
        url: doc.file_url,
        sizeBytes: 34412922,
        mimeType: "application/pdf",
      }
    : undefined;

  return {
    body: `### 📖 W.O.I.S (Work Order Intelligence Smartbook) — Complete SOP Manual

${doc.content}`,
    confidence_tag: "VERIFIED",
    source_type: "sop",
    sources: [
      {
        documentTitle: doc.title,
        sectionTitle: "Full Document Outline (Pages 1–41)",
        sourceType: "sop",
        version: doc.version,
        lastReviewed: doc.last_reviewed,
      },
    ],
    attachment,
    is_full_document: true,
  };
}

export interface SearchMatch {
  docTitle: string;
  source_type: WoisSourceType;
  is_official?: boolean;
  metadata?: Record<string, unknown>;
  version: string;
  last_reviewed: string;
  chunk: {
    section_title: string;
    page_number?: number;
    content: string;
    keywords: string[];
    roleScope?: string[];
  };
  score: number;
}

const STOP_WORDS = new Set([
  "what",
  "is",
  "the",
  "for",
  "and",
  "can",
  "how",
  "you",
  "does",
  "with",
  "from",
  "are",
  "this",
  "that",
  "there",
  "about",
  "have",
  "has",
  "will",
  "per",
  "rate",
  "all",
  "out",
  "where",
  "when",
  "which",
  "into",
  "onto",
]);

export function searchKnowledgeBase(query: string, _userContext: UserContext): SearchMatch[] {
  const queryWords = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const matches: SearchMatch[] = [];

  for (const doc of WOIS_KNOWLEDGE_DOCUMENTS) {
    for (const chunk of doc.chunks) {
      let score = 0;
      let matchedKeywords = 0;
      const lowerSection = chunk.section_title.toLowerCase();
      const lowerContent = chunk.content.toLowerCase();

      // Check keywords
      for (const kw of chunk.keywords) {
        if (query.includes(kw.toLowerCase())) {
          score += 35;
          matchedKeywords++;
        }
      }

      // Check word hits in title & content with regex boundary
      for (const word of queryWords) {
        const regex = new RegExp(`\\b${word}\\b`, "i");
        if (regex.test(lowerSection)) score += 15;
        if (regex.test(lowerContent)) score += 5;
      }

      // Source-type Precedence Weighting: only if there is a substantive match
      if (score >= 20 || matchedKeywords > 0) {
        if (doc.source_type === "sop") score += 10;
        if (doc.source_type === "app_help") score += 5;
        if (doc.source_type === "regulatory") score += 2;

        matches.push({
          docTitle: doc.title,
          source_type: doc.source_type,
          is_official: doc.is_official,
          metadata: doc.metadata,
          version: doc.version,
          last_reviewed: doc.last_reviewed,
          chunk,
          score,
        });
      }
    }
  }

  // Sort by highest relevance score
  matches.sort((a, b) => b.score - a.score);
  return matches;
}

// App-usage answers link straight to the real screen instead of just
// describing it — matched by the same chunk section_title used in
// wois-data.ts. Same deep-link-by-href pattern as the "Needs Your Action"
// dashboard panel (lib/dashboard/needs-your-action.ts).
const APP_HELP_ACTIONS: Record<string, { href: string; label: string }> = {
  "SEC 016 Aircraft Attendance Guide": { href: "/avsec/reports/sec016", label: "Open SEC016" },
  "Overtime (OT) Automatic Calculation Guide": { href: "/avsec/duty/overtime", label: "Open My Overtime" },
  "Duty Check-In and Timesheet Guide": { href: "/avsec/duty", label: "Open Duty Check-In" },
  "Anonymous Staff Feedback Guide": { href: "/avsec/feedback", label: "Open Staff Feedback" },
  "Bay Board Operational Guide": { href: "/avsec/bay-board", label: "Open Bay Board" },
};

/** Only flags ambiguity when the TOP match itself is weak (a confident,
 * strongly-scored match is answered directly even if a related document
 * also scores close — e.g. "19 ICAO annexes" legitimately scores well
 * against both the general-aviation KB and the Annex 17 KB, and should
 * just be answered, not questioned) AND a second, differently-titled
 * match is close behind it — e.g. a bare "bay" could mean the SEC016
 * bay/parking-bay field or the Bay Board feature, and neither score is
 * strong enough to trust picking one over the other. */
function detectAmbiguity(results: SearchMatch[]): SearchMatch[] | null {
  if (results.length < 2) return null;
  const [first, second] = results;
  if (first.score >= 35) return null;
  if (first.chunk.section_title === second.chunk.section_title) return null;
  if (first.score - second.score > 10) return null;
  return [first, second];
}

function handleAmbiguousQuery(candidates: SearchMatch[]): WoisEngineResponse {
  const options = candidates.map((c) => `- ${c.chunk.section_title}`).join("\n");
  return {
    body: `That could mean a couple of things — which did you mean?\n\n${options}\n\nAsk me about one of these specifically and I'll give you the full answer.`,
    confidence_tag: "UNCERTAIN",
    source_type: "general",
    sources: [],
  };
}

function handleAppHelpResponse(
  _query: string,
  match: SearchMatch,
  citations: WoisSourceCitation[],
  userContext: UserContext
): WoisEngineResponse {
  // Branch adaptation for Bay Board or IFC workflows
  let branchContextNote = "";
  if (match.chunk.section_title.includes("Bay Board")) {
    if (userContext.ops_group === "ifc_avsec") {
      branchContextNote = "\n\n*Note for IFC AVSEC: The Bay Board is configured for Operation & Hub AVSEC aircraft turnaround monitoring. For IFC catering & warehouse flows, use Transaction History.*";
    }
  }

  const body = `${match.chunk.content}${branchContextNote}`;
  const action = APP_HELP_ACTIONS[match.chunk.section_title];

  return {
    body,
    confidence_tag: "VERIFIED",
    source_type: "app_help",
    sources: citations,
    actionHref: action?.href,
    actionLabel: action?.label,
  };
}

function handleOperationalResponse(
  _query: string,
  match: SearchMatch,
  citations: WoisSourceCitation[],
  _userContext: UserContext
): WoisEngineResponse {
  // A short, natural follow-on sentence for the topics where there's a concrete action
  // worth calling out — left empty for everything else rather than forcing generic filler.
  let followOn = "";
  if (match.chunk.section_title.includes("Aircraft Search")) {
    followOn = " In practice: A320 needs at least 30 minutes, A321 at least 35, and A330 at least 45 — seal all doors/hatches if the aircraft is left unattended.";
  } else if (match.chunk.section_title.includes("Disruptive")) {
    followOn = " Assess the severity level first — Level 2 and above means a written warning and AVSEC standby on touchdown.";
  } else if (match.chunk.section_title.includes("Lithium") || match.chunk.section_title.includes("Dangerous Goods")) {
    followOn = " To check: Wh = mAh × V / 1000, and loose batteries/power banks must stay in carry-on baggage only.";
  }

  const isOfficialSop = match.source_type === "sop" && match.is_official !== false;
  const tag: WoisConfidenceTag = isOfficialSop ? "VERIFIED" : "GENERAL_KNOWLEDGE";
  const pageLabel = match.chunk.page_number ? `, p.${match.chunk.page_number}` : "";

  const caveat =
    tag === "GENERAL_KNOWLEDGE"
      ? match.docTitle === "General Aviation Knowledge Base" || match.docTitle.startsWith("ICAO Annex 17")
        ? " This is general/industry-standard knowledge, not confirmed AirAsia policy — verify with your SOP/DSE for anything operationally consequential."
        : " This is a general aviation reference, not official AirAsia policy — verify with your SOP/DSE."
      : "";

  const body = `${match.chunk.content}${followOn}${caveat}\n\n(${match.docTitle}${pageLabel} — ${match.chunk.section_title})`;

  return {
    body,
    confidence_tag: tag,
    source_type: match.source_type,
    sources: citations,
  };
}

function handleFallbackReasoning(query: string, _userContext: UserContext): WoisEngineResponse {
  // Check if query is about standard aviation general knowledge (e.g. general aircraft, weather, international codes)
  if (
    query.includes("icao") ||
    query.includes("iata") ||
    query.includes("aviation") ||
    query.includes("power bank") ||
    query.includes("battery")
  ) {
    return {
      body: `General civil aviation security guidelines allow small electronic devices and power banks up to 100Wh in carry-on baggage. Between 100Wh and 160Wh needs airline operator approval, and anything above that isn't permitted. Keep battery devices in carry-on only, never in checked baggage.

This is based on general ICAO/IATA DGR standards, not confirmed AirAsia policy — verify with your DSE/SOP for local station implementation.`,
      confidence_tag: "GENERAL_KNOWLEDGE",
      source_type: "general",
      sources: [
        {
          documentTitle: "General Aviation Security Reference",
          sectionTitle: "Standard Civil Aviation Rules",
          sourceType: "general",
        },
      ],
    };
  }

  // Company-specific question without SOP entry
  if (
    query.includes("allowance") ||
    query.includes("salary") ||
    query.includes("uniform claim") ||
    query.includes("hotel") ||
    query.includes("per diem")
  ) {
    return {
      body: `That's a company-specific administrative question and I don't have that policy in my knowledge base — best to check with your Duty Security Executive (DSE) or station management directly.`,
      confidence_tag: "REQUIRES_SOP",
      source_type: "general",
      sources: [],
    };
  }

  // Insufficient information / Uncertain
  return {
    body: `I'm not sure what you're asking — could you give me a bit more to go on? Naming the aircraft type, duty area, or report code usually helps me find the right procedure.`,
    confidence_tag: "UNCERTAIN",
    source_type: "general",
    sources: [],
  };
}
