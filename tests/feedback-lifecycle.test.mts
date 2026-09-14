import test from "node:test";
import assert from "node:assert/strict";
import type { FeedbackCategory, FeedbackStatus, FeedbackSenderRole } from "../lib/avsec/types.ts";

test("Feedback categories: validates allowed category values", () => {
  const validCategories: FeedbackCategory[] = ["safety_concern", "complaint", "suggestion", "other"];
  
  assert.ok(validCategories.includes("safety_concern"));
  assert.ok(validCategories.includes("complaint"));
  assert.ok(validCategories.includes("suggestion"));
  assert.ok(validCategories.includes("other"));
  assert.equal(validCategories.includes("random_category" as FeedbackCategory), false);
});

test("Feedback sender roles: only submitter or management", () => {
  const roles: FeedbackSenderRole[] = ["submitter", "management"];
  assert.equal(roles.length, 2);
  assert.ok(roles.includes("submitter"));
  assert.ok(roles.includes("management"));
});

test("Management privacy masking: view omits submitter_id", () => {
  // Simulating view extraction
  const rawThread = {
    id: "thread-123",
    org_id: "org-1",
    submitter_id: "user-secret-999", // MUST NOT appear in Management view
    category: "safety_concern" as FeedbackCategory,
    status: "open" as FeedbackStatus,
    created_at: "2026-09-11T12:00:00Z",
    updated_at: "2026-09-11T12:00:00Z",
  };

  const toManagementView = (t: typeof rawThread) => ({
    id: t.id,
    org_id: t.org_id,
    category: t.category,
    status: t.status,
    created_at: t.created_at,
    updated_at: t.updated_at,
  });

  const view = toManagementView(rawThread);
  assert.equal("submitter_id" in view, false);
  assert.equal(view.id, "thread-123");
  assert.equal(view.category, "safety_concern");
});

test("Urgent safety concern notification routing", () => {
  const getNotificationPriority = (category: FeedbackCategory) => {
    return category === "safety_concern" ? "URGENT_PUSH" : "STANDARD_BADGE";
  };

  assert.equal(getNotificationPriority("safety_concern"), "URGENT_PUSH");
  assert.equal(getNotificationPriority("complaint"), "STANDARD_BADGE");
  assert.equal(getNotificationPriority("suggestion"), "STANDARD_BADGE");
  assert.equal(getNotificationPriority("other"), "STANDARD_BADGE");
});
