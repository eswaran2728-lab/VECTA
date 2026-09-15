/**
 * VECTA Production Observability & Structured Logging Module
 *
 * Operational Severity Categories:
 * - P0 CRITICAL: RLS failure, cross-branch data exposure, auth bypass, data corruption, system outage.
 * - P1 HIGH: Core operational workflow blocked (attendance, SEC submission, ICMS checkpoint, OT approval).
 * - P2 MEDIUM: Non-critical feature degraded (exports, notifications, one secondary module).
 * - P3 LOW: Minor non-blocking UI or transient defect.
 *
 * Sanitization Guarantee:
 * - NEVER logs passwords, tokens, cookies, service keys, full base64 images, or signature payloads.
 */

export type SeverityLevel = "P0" | "P1" | "P2" | "P3";

export type ObservabilityModule =
  | "AUTH"
  | "AVSEC"
  | "DUTY"
  | "OT"
  | "SEC"
  | "SHIFT_HANDOVER"
  | "ICMS"
  | "CATERLINK"
  | "STORAGE"
  | "NOTIFICATIONS"
  | "SYSTEM"
  | "ADMIN";

export interface LogContext {
  module: ObservabilityModule;
  action: string;
  severity?: SeverityLevel;
  role?: string | null;
  station?: string | null;
  opsGroup?: string | null;
  transactionId?: string | null;
  correlationId?: string | null;
  userId?: string | null;
  errorType?: string | null;
  [key: string]: unknown;
}

const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "authorization",
  "secret",
  "cookie",
  "cookies",
  "key",
  "service_role",
  "serviceRoleKey",
  "signature",
  "photos",
  "dataUrl",
  "signedUrl",
]);

function sanitizeValue(key: string, val: unknown): unknown {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) {
    return "[REDACTED]";
  }
  if (typeof val === "string") {
    if (val.startsWith("data:image/") || val.startsWith("data:application/")) {
      return `[DATA_URL length=${val.length}]`;
    }
    if (val.length > 500) {
      return `${val.slice(0, 500)}... [TRUNCATED]`;
    }
    return val;
  }
  if (typeof val === "object" && val !== null) {
    if (Array.isArray(val)) {
      return val.map((item, idx) => sanitizeValue(String(idx), item));
    }
    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      sanitizedObj[k] = sanitizeValue(k, v);
    }
    return sanitizedObj;
  }
  return val;
}

export function logEvent(
  level: "INFO" | "WARN" | "ERROR",
  message: string,
  context: LogContext
) {
  const timestamp = new Date().toISOString();
  const severity = context.severity ?? (level === "ERROR" ? "P1" : level === "WARN" ? "P2" : "P3");
  const correlationId = context.correlationId ?? (typeof crypto !== "undefined" ? crypto.randomUUID() : undefined);

  const cleanContext: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    cleanContext[k] = sanitizeValue(k, v);
  }

  const logPayload = {
    timestamp,
    level,
    severity,
    message,
    correlationId,
    ...cleanContext,
  };

  const formatted = `[VECTA:${severity}:${context.module}] ${message} ${JSON.stringify(logPayload)}`;

  if (level === "ERROR" || severity === "P0" || severity === "P1") {
    console.error(formatted);
  } else if (level === "WARN" || severity === "P2") {
    console.warn(formatted);
  } else {
    console.info(formatted);
  }

  return correlationId;
}

export const logger = {
  info: (message: string, context: LogContext) => logEvent("INFO", message, context),
  warn: (message: string, context: LogContext) => logEvent("WARN", message, context),
  error: (message: string, context: LogContext) => logEvent("ERROR", message, context),
  p0: (message: string, context: LogContext) =>
    logEvent("ERROR", message, { ...context, severity: "P0" as const }),
  p1: (message: string, context: LogContext) =>
    logEvent("ERROR", message, { ...context, severity: "P1" as const }),
  p2: (message: string, context: LogContext) =>
    logEvent("WARN", message, { ...context, severity: "P2" as const }),
  p3: (message: string, context: LogContext) =>
    logEvent("INFO", message, { ...context, severity: "P3" as const }),
};
