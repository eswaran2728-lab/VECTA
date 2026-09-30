// Phase 8 certification: interactive client-component test for
// EnforcementLeaveDecisionControls (Main Enforcement's leave approve/
// reject control). Renders the REAL component with React Testing
// Library against a jsdom document, mocking only the two boundaries a
// client component legitimately cannot cross in a Node test (the
// Next.js router and the server action it calls) -- never re-
// implementing the component's own interactive logic. Server-side
// authorization for reviewLeaveApplication() itself is proven
// separately (tests/phase8-leave-routing.test.mts and the DB-
// integration suite); this test is scoped to what the client component
// actually owns: rendering the confirm-with-notes flow, calling the
// action with the right arguments, and reflecting loading/error state.
//
// React Server Component pages (the ones that load data via async
// server calls) cannot run under jsdom/RTL and are not tested this
// way -- this is the interactive leaf-component split the certification
// instructions call for.
import test from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";
import { installJsdom } from "./mocks/dom-setup.mts";

installJsdom();

const React = (await import("react")).default;
const { render, screen, fireEvent, cleanup } = await import("@testing-library/react");
const { act } = await import("react");

let lastReviewCall: unknown[] | null = null;
let reviewResult: { success: boolean; error?: string | null } = { success: true, error: null };
let refreshCalled = 0;

mock.module("next/navigation", {
  namedExports: {
    useRouter: () => ({ refresh: () => { refreshCalled += 1; }, push: () => {}, replace: () => {} }),
  },
});
mock.module("@/lib/avsec/duty/absence-actions", {
  namedExports: {
    reviewLeaveApplication: async (input: unknown) => {
      lastReviewCall = [input];
      return reviewResult;
    },
  },
});

const { EnforcementLeaveDecisionControls } = await import("../components/avsec/enforcement/EnforcementLeaveDecisionControls.tsx");

function resetState() {
  lastReviewCall = null;
  refreshCalled = 0;
  reviewResult = { success: true, error: null };
}

test("EnforcementLeaveDecisionControls: populated state renders Approve/Reject buttons", () => {
  resetState();
  render(React.createElement(EnforcementLeaveDecisionControls, { noticeId: "notice-1", staffName: "Jane Doe" }));
  assert.ok(screen.getByText(/Approve/), "an Approve button is rendered");
  assert.ok(screen.getByText(/Reject/), "a Reject button is rendered");
  cleanup();
});

test("EnforcementLeaveDecisionControls: clicking Approve opens the confirmation prompt (not an immediate submit)", () => {
  resetState();
  render(React.createElement(EnforcementLeaveDecisionControls, { noticeId: "notice-2", staffName: "Jane Doe" }));
  fireEvent.click(screen.getByText(/✓ Approve/));
  assert.ok(screen.getByText(/Approve leave for Jane Doe/), "the confirmation prompt appears with the staff name, before any server call is made");
  assert.equal(lastReviewCall, null, "no server action call happens merely from opening the confirmation prompt");
  cleanup();
});

test("EnforcementLeaveDecisionControls: confirming Approve calls reviewLeaveApplication with the exact noticeId and action, then refreshes on success", async () => {
  resetState();
  render(React.createElement(EnforcementLeaveDecisionControls, { noticeId: "notice-3", staffName: "Jane Doe" }));
  fireEvent.click(screen.getByText(/✓ Approve/));
  await act(async () => {
    fireEvent.click(screen.getByText(/Confirm Approval/));
    // allow the pending transition's microtask to resolve
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.ok(lastReviewCall, "reviewLeaveApplication was called");
  assert.deepEqual(lastReviewCall![0], { noticeId: "notice-3", action: "approve", reviewNotes: "" }, "called with the exact notice id and action, matching what the button represents");
  assert.equal(refreshCalled, 1, "router.refresh() is called exactly once after a successful decision");
  cleanup();
});

test("EnforcementLeaveDecisionControls: a server-side denial is displayed as an error message, the prompt stays open, and router.refresh() is NOT called", async () => {
  resetState();
  reviewResult = { success: false, error: "No active Phase 3 role assignment grants authority to review this Enforcement leave request." };
  render(React.createElement(EnforcementLeaveDecisionControls, { noticeId: "notice-4", staffName: "Jane Doe" }));
  fireEvent.click(screen.getByText(/✓ Approve/));
  await act(async () => {
    fireEvent.click(screen.getByText(/Confirm Approval/));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.ok(screen.getByText(/No active Phase 3 role assignment/), "the exact server-provided denial reason is shown to the user, not a generic error");
  assert.equal(refreshCalled, 0, "router.refresh() is never called when the server denies the action");
  assert.ok(screen.getByText(/Confirm Approval/), "the confirmation prompt remains open after a failure, so the user isn't silently dropped back to the list");
  cleanup();
});

test("EnforcementLeaveDecisionControls: Cancel closes the prompt without calling the server action", () => {
  resetState();
  render(React.createElement(EnforcementLeaveDecisionControls, { noticeId: "notice-5", staffName: "Jane Doe" }));
  fireEvent.click(screen.getByText(/✕ Reject/));
  assert.ok(screen.getByText(/Reject leave for Jane Doe/));
  fireEvent.click(screen.getByText(/Cancel/));
  assert.ok(screen.getByText(/✓ Approve/), "back to the default populated state after Cancel");
  assert.equal(lastReviewCall, null, "Cancel never calls reviewLeaveApplication");
});
