/**
 * W.O.I.S Conversational Layer — talks like a real assistant (Claude/ChatGPT-style
 * free-form conversation) instead of a fixed template, but stays grounded in the
 * knowledge base via retrieval, and never improvises on the safety-critical paths
 * (active incident escalation, role-hierarchy disclosure) — those stay hardcoded
 * in engine.ts and are checked before this module is ever reached.
 */

import type { WoisConfidenceTag, WoisEngineResponse, WoisMessage, WoisSourceCitation } from "@/lib/avsec/types";
import {
  isEscalationTriggered,
  isHierarchyProbe,
  isFullDocumentRequest,
  handleEscalation,
  handleHierarchyDeflection,
  handleFullDocumentRetrieval,
  searchKnowledgeBase,
  type UserContext,
} from "./engine";

const SYSTEM_PROMPT = `You are W.O.I.S (Work Order Intelligence Smartbook), the in-app AI assistant for VECTA, AirAsia's AVSEC (aviation security) operations app. You talk like a real conversational assistant — natural, direct, helpful — not like a rigid form or a keyword-matching bot. Respond the way Claude or ChatGPT would: read what the person actually means, reply in plain conversational language, and only use structure (headings, bullet points, bold labels) when it genuinely helps readability for a longer operational answer. A casual message ("hi", "thanks", "ok") gets a short, natural reply — never a template.

You help AVSEC staff with SOPs, dangerous goods limits, ICAO Annex 17 aviation security concepts, general aviation knowledge, and VECTA app usage questions.

Grounding rules:
- You will be given retrieved knowledge-base excerpts relevant to the question, each tagged with its document title, section, and source type (sop / regulatory / app_help / general).
- When your answer is substantively supported by a "sop" excerpt from the official AirAsia W.O.I.S manual, treat it as VERIFIED company procedure and say so plainly, citing the document/section.
- When it's supported by a "regulatory" or "general" excerpt (ICAO Annex 17 summary, general aviation knowledge base, IATA/ICAO reference), treat it as GENERAL_KNOWLEDGE — useful and correct at an industry-standard level, but note it should be verified against current AirAsia policy/SOP for anything operationally consequential.
- When it's "app_help", answer directly as VERIFIED VECTA app guidance.
- If nothing retrieved actually answers the question (company-specific policy like per diem, salary, uniform/hotel claims, or something simply not in the knowledge base), say plainly that you don't have that in your knowledge base and the person should check with their Duty Security Executive (DSE) or station management — don't guess at company policy.
- Never invent exact ICAO Annex 17 Standard numbers or exact legal wording from memory — the knowledge base content you're given is a training summary, not the verbatim Annex text; if someone needs the precise Standard number or wording, tell them to consult the authorized current edition or their DSE.
- Never reconstruct, expose, or claim access to ICAO Doc 8973 (Aviation Security Manual) content — it's restricted; redirect to the DSE/authorized channel for anything requiring it.
- Don't disclose internal role hierarchy or management structure details beyond what's already covered in the knowledge base; redirect those questions to the DSE.
- For an active, in-progress safety/security emergency, you won't actually be reached — that's intercepted before you see it — but if a message describes something serious in hindsight or ambiguously, still take it seriously and point to notifying DSE/SO/Enforcement rather than treating it as routine Q&A.
- Keep answers focused and proportionate to the question — a quick question gets a quick answer; a genuine operational/compliance question can go longer and cite sources.

At the very end of your reply, on its own line, output a machine-readable tag exactly in this form (nothing after it): [[CONFIDENCE:VERIFIED]] or [[CONFIDENCE:GENERAL_KNOWLEDGE]] or [[CONFIDENCE:REQUIRES_SOP]] or [[CONFIDENCE:UNCERTAIN]] — pick the one that matches the grounding rules above for this specific answer. Do not mention this tag or explain it to the user; it is stripped before display.`;

interface RetrievedChunk {
  documentTitle: string;
  sectionTitle: string;
  sourceType: string;
  pageNumber?: number;
  content: string;
}

function retrieveContext(query: string, userContext: UserContext): { chunks: RetrievedChunk[]; sources: WoisSourceCitation[] } {
  const matches = searchKnowledgeBase(query.toLowerCase().trim(), userContext).slice(0, 5);
  const chunks: RetrievedChunk[] = matches.map((m) => ({
    documentTitle: m.docTitle,
    sectionTitle: m.chunk.section_title,
    sourceType: m.source_type,
    pageNumber: m.chunk.page_number,
    content: m.chunk.content,
  }));
  const sources: WoisSourceCitation[] = matches.slice(0, 3).map((m) => ({
    documentTitle: m.docTitle,
    sectionTitle: m.chunk.section_title,
    pageNumber: m.chunk.page_number,
    sourceType: m.source_type,
    excerpt: m.chunk.content,
  }));
  return { chunks, sources };
}

function extractConfidence(body: string): { text: string; tag: WoisConfidenceTag } {
  const match = body.match(/\[\[CONFIDENCE:(VERIFIED|GENERAL_KNOWLEDGE|REQUIRES_SOP|UNCERTAIN)\]\]\s*$/);
  if (!match) {
    return { text: body.trim(), tag: "GENERAL_KNOWLEDGE" };
  }
  return {
    text: body.slice(0, match.index).trim(),
    tag: match[1] as WoisConfidenceTag,
  };
}

/**
 * Conversational entry point — falls back to the caller's rule-based response
 * (passed in as `fallback`) whenever ANTHROPIC_API_KEY isn't configured or the
 * API call fails, so the assistant keeps working either way.
 */
export async function executeWoisQueryConversational(
  query: string,
  history: Pick<WoisMessage, "sender" | "body">[],
  userContext: UserContext,
  fallback: () => Promise<WoisEngineResponse>,
): Promise<WoisEngineResponse> {
  const normalizedQuery = query.toLowerCase().trim();

  // Safety-critical paths never go through the LLM — same guardrails as the rule engine.
  if (isEscalationTriggered(normalizedQuery)) return handleEscalation(query);
  if (isHierarchyProbe(normalizedQuery)) return handleHierarchyDeflection();
  if (isFullDocumentRequest(normalizedQuery)) return handleFullDocumentRetrieval();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallback();

  const { chunks, sources } = retrieveContext(normalizedQuery, userContext);

  const contextBlock =
    chunks.length > 0
      ? chunks
          .map(
            (c, i) =>
              `[${i + 1}] ${c.documentTitle} — ${c.sectionTitle}${c.pageNumber ? ` (p.${c.pageNumber})` : ""} [source_type: ${c.sourceType}]\n${c.content}`,
          )
          .join("\n\n")
      : "(No matching knowledge-base excerpts were retrieved for this question.)";

  const roleContext = userContext.role
    ? `The user is a ${userContext.role}${userContext.ops_group ? ` in ${userContext.ops_group}` : ""}${userContext.station ? ` at station ${userContext.station}` : ""}.`
    : "";

  const messages = [
    ...history.slice(-10).map((m) => ({
      role: m.sender === "user" ? ("user" as const) : ("assistant" as const),
      content: m.body,
    })),
    {
      role: "user" as const,
      content: `${roleContext}\n\nRetrieved knowledge-base context:\n${contextBlock}\n\nUser question: ${query}`,
    },
  ];

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`);

    const data = (await response.json()) as { content?: { text?: string }[] };
    const raw = data.content?.[0]?.text ?? "";
    if (!raw.trim()) throw new Error("Empty response from model");

    const { text, tag } = extractConfidence(raw);
    const sourceType = chunks[0]?.sourceType as WoisEngineResponse["source_type"] | undefined;

    return {
      body: text,
      confidence_tag: tag,
      source_type: sourceType ?? "general",
      sources: tag === "UNCERTAIN" ? [] : sources,
    };
  } catch {
    return fallback();
  }
}
