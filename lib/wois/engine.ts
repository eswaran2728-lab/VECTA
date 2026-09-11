/**
 * W.O.I.S Intelligence Engine (World of Intelligent Aviation Systems)
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

export async function executeWoisQuery(
  query: string,
  userContext: UserContext = {}
): Promise<WoisEngineResponse> {
  const normalizedQuery = query.toLowerCase().trim();

  // Safety Policy 1: Immediate Security / Incident Escalation
  if (isEscalationTriggered(normalizedQuery)) {
    return handleEscalation(query);
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

  // Primary Matched Result from Knowledge Base
  const topMatch = searchResults[0];
  const citations: WoisSourceCitation[] = searchResults.slice(0, 3).map((r) => ({
    documentTitle: r.docTitle,
    sectionTitle: r.chunk.section_title,
    pageNumber: r.chunk.page_number,
    sourceType: r.source_type,
    excerpt: r.chunk.content,
  }));

  // Handle App Help Direct Answers
  if (topMatch.source_type === "app_help") {
    return handleAppHelpResponse(normalizedQuery, topMatch, citations, userContext);
  }

  // Handle Substantive Operational Questions (SOP & Regulatory)
  return handleOperationalResponse(normalizedQuery, topMatch, citations, userContext);
}

function isEscalationTriggered(query: string): boolean {
  return ESCALATION_TRIGGERS.some((trigger) => query.includes(trigger));
}

function isHierarchyProbe(query: string): boolean {
  return HIERARCHY_PROBES.some((probe) => query.includes(probe));
}

function isFullDocumentRequest(query: string): boolean {
  return FULL_DOC_TRIGGERS.some((t) => query.includes(t)) || query === "wois" || query === "w.o.i.s";
}

function isMissingPolicyProbe(query: string): boolean {
  return ADMIN_POLICY_TRIGGERS.some((t) => query.includes(t));
}

function handleRequiresSop(): WoisEngineResponse {
  return {
    body: `**Assessment**: Query requires company-specific administrative or operational policy.
**Status**: The requested procedure is not currently available in the W.O.I.S operational knowledge base.
**Recommended Action**: Please contact your Duty Security Executive (DSE) or station management to verify the applicable policy.
**Confidence**: 🟡 REQUIRES SOP
**Source**: Knowledge Base Missing Reference`,
    confidence_tag: "REQUIRES_SOP",
    source_type: "general",
    sources: [],
  };
}

function handleEscalation(query: string): WoisEngineResponse {
  const body = `### 🚨 URGENT OPERATIONAL ESCALATION REQUIRED

**Assessment**: The query describes an active high-risk safety or security emergency (${query}).
**Immediate Action Required**:
1. **DO NOT** attempt to resolve this via Q&A or standard documentation.
2. Immediately notify your **Duty Security Executive (DSE)**, **Security Officer (SO)**, and **Enforcement**.
3. For in-flight or cabin incidents, notify the **Pilot-in-Command (PIC)** immediately.
4. For terminal or ramp security threats, contact **Airport Police** and activate local emergency response protocols.
5. Once contained, file a mandatory **SEC 014 Incident Report** in VECTA.

**Confidence**: 🔴 ESCALATE
**Source**: AirAsia Emergency Response & Security SOP Protocol`;

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

function handleHierarchyDeflection(): WoisEngineResponse {
  return {
    body: `I am W.O.I.S, your operational intelligence assistant. I am designed to assist you with standard operating procedures (SOPs), dangerous goods limits, security screening checks, and VECTA app features for your assigned station duties. 

For inquiries regarding specific departmental organization, please consult with your Duty Security Executive (DSE).`,
    confidence_tag: "GENERAL_KNOWLEDGE",
    source_type: "general",
    sources: [],
  };
}

function handleFullDocumentRetrieval(): WoisEngineResponse {
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
    body: `### 📖 W.O.I.S (World of Intelligent Aviation Systems) — Complete SOP Manual

${doc.content}`,
    confidence_tag: "VERIFIED",
    source_type: "sop",
    sources: [
      {
        documentTitle: doc.title,
        sectionTitle: "Full Document Outline (Pages 1–41)",
        sourceType: "sop",
      },
    ],
    attachment,
    is_full_document: true,
  };
}

interface SearchMatch {
  docTitle: string;
  source_type: WoisSourceType;
  is_official?: boolean;
  metadata?: Record<string, unknown>;
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

function searchKnowledgeBase(query: string, _userContext: UserContext): SearchMatch[] {
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

  const body = `### 📋 VECTA App Guide: ${match.chunk.section_title}

${match.chunk.content}${branchContextNote}

---
**Confidence**: 🟢 VERIFIED
**Source**: VECTA Operations Suite In-App Documentation`;

  return {
    body,
    confidence_tag: "VERIFIED",
    source_type: "app_help",
    sources: citations,
  };
}

function handleOperationalResponse(
  _query: string,
  match: SearchMatch,
  citations: WoisSourceCitation[],
  _userContext: UserContext
): WoisEngineResponse {
  // Check specific search timings or procedures
  let recommendedAction = "Adhere strictly to the approved procedural sequence outlined in the relevant SOP.";
  if (match.chunk.section_title.includes("Aircraft Search")) {
    recommendedAction = "Ensure aircraft is searched according to type: A320 (>=30 min), A321 (>=35 min), A330 (>=45 min). Seal all doors/hatches if left unattended.";
  } else if (match.chunk.section_title.includes("Disruptive")) {
    recommendedAction = "Assess incident severity level. For Level 2 and above, issue written warning and ensure AVSEC standby upon touchdown.";
  } else if (match.chunk.section_title.includes("Lithium") || match.chunk.section_title.includes("Dangerous Goods")) {
    recommendedAction = "Verify power bank / dangerous goods capacity in Wh (Wh = mAh * V / 1000). Ensure loose batteries/power banks are in carry-on baggage only.";
  }

  const isOfficialSop = match.source_type === "sop" && match.is_official !== false;
  const tag: WoisConfidenceTag = isOfficialSop ? "VERIFIED" : "GENERAL_KNOWLEDGE";
  const disclaimerText =
    match.docTitle === "General Aviation Knowledge Base"
      ? "General aviation knowledge base — verify against current AirAsia policy/SOP for anything operationally consequential"
      : "General aviation reference (industry-standard, not official AirAsia policy) — verify with your SOP/DSE";

  const caveat =
    tag === "GENERAL_KNOWLEDGE"
      ? `\n*Note: ${disclaimerText}.*`
      : "";

  const pageLabel = match.chunk.page_number ? ` · Page ${match.chunk.page_number}` : "";
  const sourceSuffix =
    tag === "GENERAL_KNOWLEDGE"
      ? ` — ${disclaimerText}`
      : "";

  const body = `**Assessment**: Inquiries regarding ${match.chunk.section_title.toLowerCase()} and operational compliance.
**Verified Information**: ${match.chunk.content}
**Relevant Procedure**: ${match.docTitle}${pageLabel} — Section: ${match.chunk.section_title}
**Recommended Action**: ${recommendedAction}
**Confidence**: ${tag === "VERIFIED" ? "🟢 VERIFIED" : "🔵 GENERAL KNOWLEDGE"}
**Source**: ${match.docTitle}${pageLabel} (${match.chunk.section_title})${sourceSuffix}${caveat}`;

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
      body: `**Assessment**: General aviation question regarding regulatory or industry standards.
**Verified Information**: General civil aviation security guidelines permit small electronic devices and power banks up to 100Wh in carry-on baggage. Devices between 100Wh and 160Wh require airline operator approval.
**Relevant Procedure**: International Civil Aviation Organization (ICAO) / IATA DGR Standard Reference.
**Recommended Action**: Advise passenger to keep battery devices in carry-on baggage only.
**Confidence**: 🔵 GENERAL KNOWLEDGE
**Source**: Authoritative General Aviation Reference

*Note: This guidance is based on general international aviation regulatory standards. It is not confirmed AirAsia policy; please verify with your DSE/SOP for local station implementation.*`,
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
      body: `**Assessment**: Query requires company-specific administrative or operational policy.
**Status**: The requested procedure is not currently available in the W.O.I.S operational knowledge base.
**Recommended Action**: Please contact your Duty Security Executive (DSE) or station management to verify the applicable policy.
**Confidence**: 🟡 REQUIRES SOP
**Source**: Knowledge Base Missing Reference`,
      confidence_tag: "REQUIRES_SOP",
      source_type: "general",
      sources: [],
    };
  }

  // Insufficient information / Uncertain
  return {
    body: `**Assessment**: Insufficient information provided to determine the applicable security or operational procedure.
**Recommended Action**: Please rephrase your question with specific operational context (e.g., aircraft type, duty area, or report code).
**Confidence**: 🟠 UNCERTAIN
**Source**: N/A`,
    confidence_tag: "UNCERTAIN",
    source_type: "general",
    sources: [],
  };
}
