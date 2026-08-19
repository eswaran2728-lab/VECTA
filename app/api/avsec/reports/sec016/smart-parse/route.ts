import { NextResponse } from "next/server";
import { requireProfile } from "@/lib/avsec/auth";
import {
  parseSec016WhatsAppMessage,
  SEC016_PARSEABLE_FIELDS,
  type Sec016ParsedFields,
} from "@/lib/avsec/smart-input/sec016Parser";

// Fields worth a second pass from Claude when the regex parser can't confidently pull
// them out — currently just the one true free-text field in the parseable set.
const AI_ASSIST_FIELDS: (keyof Sec016ParsedFields)[] = ["reason_for_delay"];

export async function POST(request: Request) {
  await requireProfile();

  const body = (await request.json().catch(() => null)) as { text?: string } | null;
  const text = body?.text?.trim();
  if (!text) {
    return NextResponse.json({ error: "No text provided" }, { status: 400 });
  }

  const regexResult = parseSec016WhatsAppMessage(text);
  let result: Sec016ParsedFields = { ...regexResult };
  let usedAi = false;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const missing = AI_ASSIST_FIELDS.filter((f) => !result[f]);

  if (apiKey && missing.length > 0) {
    try {
      const aiValues = await extractWithClaude(text, missing, apiKey);
      // Regex matches are more literal/trustworthy than an AI guess — never let the
      // AI pass override something the regex parser already found.
      result = { ...aiValues, ...regexResult };
      usedAi = true;
    } catch {
      // Best-effort only. The regex-only result still stands, nothing to surface to the user.
    }
  }

  const filledFields = SEC016_PARSEABLE_FIELDS.filter((f) => Boolean(result[f]));

  return NextResponse.json({
    values: result,
    filledFields,
    totalFields: SEC016_PARSEABLE_FIELDS.length,
    usedAi,
  });
}

async function extractWithClaude(
  text: string,
  fields: (keyof Sec016ParsedFields)[],
  apiKey: string,
): Promise<Partial<Sec016ParsedFields>> {
  const system =
    "You extract structured data from a pasted aircraft-handling WhatsApp message for an " +
    "aviation security report. Only extract a value for a field if it is explicitly and " +
    "unambiguously present in the message. If a field is not mentioned, or you are not fully " +
    "confident, return null for it — never guess, infer, paraphrase, or fabricate a value. " +
    `Respond with ONLY a JSON object, no other text, with exactly these keys: ${fields.join(", ")}.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 512,
      system,
      messages: [{ role: "user", content: text }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = (await response.json()) as { content?: { text?: string }[] };
  const raw = data.content?.[0]?.text ?? "{}";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw) as Record<string, unknown>;

  const out: Partial<Sec016ParsedFields> = {};
  for (const field of fields) {
    const value = parsed[field];
    if (value !== null && value !== undefined && String(value).trim()) {
      (out as Record<string, unknown>)[field] = value;
    }
  }
  return out;
}
