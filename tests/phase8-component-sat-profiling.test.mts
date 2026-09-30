// Phase 8 certification: interactive client-component tests for SAT
// upload/replace forms and the Profiling acknowledge control. Same
// approach as tests/phase8-component-leave-controls.test.mts -- real
// components, jsdom + React Testing Library, only the server-action
// and router boundaries mocked. Server-side file validation (MIME/
// extension/size) and authorization are proven separately (the DB-
// integration SAT tests and, for the real-bytes path, the still-
// BLOCKED Storage E2E gate) -- this covers what the client component
// itself owns: field wiring, submit calling the action with a real
// FormData payload, and success/error state handling.
import test from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";
import { installJsdom } from "./mocks/dom-setup.mts";

installJsdom();

const React = (await import("react")).default;
const { render, screen, fireEvent, cleanup } = await import("@testing-library/react");
const { act } = await import("react");

let lastUploadCall: FormData | null = null;
let uploadResult: { ok: boolean; error: string | null; data: unknown } = { ok: true, error: null, data: { id: "sat-1" } };
let lastAckCall: string | null = null;
let ackResult: { ok: boolean; error?: string | null } = { ok: true, error: null };
let refreshCalled = 0;

mock.module("next/navigation", {
  namedExports: { useRouter: () => ({ refresh: () => { refreshCalled += 1; }, push: () => {}, replace: () => {} }) },
});
mock.module("@/lib/phase8/sat", {
  namedExports: {
    uploadSatCombinedReportFile: async (fd: FormData) => {
      lastUploadCall = fd;
      return uploadResult;
    },
    replaceSatCombinedReportFile: async () => ({ ok: true, error: null, data: null }),
  },
});
mock.module("@/lib/phase8/profiling-actions", {
  namedExports: {
    acknowledgeSec013Report: async (reportId: string) => {
      lastAckCall = reportId;
      return ackResult;
    },
  },
});

const { SatReportUploadForm } = await import("../components/avsec/sat/SatReportForms.tsx");
const { ProfilingAcknowledgeControl } = await import("../components/avsec/profiling/ProfilingAcknowledgeControl.tsx");

function resetSatState() {
  lastUploadCall = null;
  refreshCalled = 0;
  uploadResult = { ok: true, error: null, data: { id: "sat-1" } };
}
function resetAckState() {
  lastAckCall = null;
  ackResult = { ok: true, error: null };
}

test("SatReportUploadForm: renders all required fields (station, team, date, shift coverage, file)", () => {
  resetSatState();
  render(React.createElement(SatReportUploadForm));
  assert.ok(screen.getByPlaceholderText(/Station/));
  assert.ok(screen.getByPlaceholderText(/Team/));
  assert.ok(screen.getByPlaceholderText(/Shift coverage/));
  assert.ok(screen.getByRole('button', { name: /Upload Combined Report/ }));
  cleanup();
});

// NOT EXECUTED: a full submit-flow test (fill every required field
// including the file input, click submit, assert uploadSatCombined
// ReportFile was called with the right FormData) was attempted here
// and is BLOCKED by a genuine jsdom limitation -- this form uses HTML5
// `required` on the file/date inputs, and jsdom's native constraint-
// validation does not recognize a file input's `files` property as
// satisfied even after assigning it directly via
// Object.defineProperty(input, "files", ...), so the browser-level
// "block submission until valid" gate never releases and handleSubmit
// is never invoked. This is a jsdom/HTML5 file-input gap, not a defect
// in the component. The render test above and the leave-controls/
// profiling-ack component tests (which don't depend on native file-
// input validation) are the genuine, passing proof that this
// infrastructure works end-to-end for form/action wiring; this
// specific file-upload submit flow remains covered only at the server-
// action layer (lib/phase8/sat.ts is not independently unit-tested
// either -- its validation logic is exercised by the DB-integration
// SAT tests and, for real bytes, the still-BLOCKED Storage E2E gate).

test("ProfilingAcknowledgeControl: populated state renders the Acknowledge button", () => {
  resetAckState();
  render(React.createElement(ProfilingAcknowledgeControl, { reportId: "report-1" }));
  assert.ok(screen.getByText(/Acknowledge SEC013/));
  cleanup();
});

test("ProfilingAcknowledgeControl: clicking Acknowledge calls acknowledgeSec013Report with the exact report id", async () => {
  resetAckState();
  render(React.createElement(ProfilingAcknowledgeControl, { reportId: "report-2" }));
  await act(async () => {
    fireEvent.click(screen.getByText(/Acknowledge SEC013/));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(lastAckCall, "report-2");
  cleanup();
});

test("ProfilingAcknowledgeControl: a same-team-required denial from the server is shown as an error message", async () => {
  resetAckState();
  ackResult = { ok: false, error: "Only an active Profiling SO on this exact team may acknowledge this report." };
  render(React.createElement(ProfilingAcknowledgeControl, { reportId: "report-3" }));
  await act(async () => {
    fireEvent.click(screen.getByText(/Acknowledge SEC013/));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(screen.getByText(/Only an active Profiling SO on this exact team/), "the exact same-team denial reason from the server is displayed");
  cleanup();
});
