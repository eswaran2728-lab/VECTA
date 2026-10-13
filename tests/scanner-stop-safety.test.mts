import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { stopScannerSafely } from "../lib/icms/scanner-stop.ts";

/**
 * Root cause of the PEN/JHB "checkpoint opens" failure: html5-qrcode's stop() THROWS SYNCHRONOUSLY ("Cannot stop, scanner is not
 * running or paused.") when the camera is not scanning (unavailable, denied, still starting, or never started). The scan screen called
 * `scannerRef.current?.stop().catch(...)`, so the synchronous throw escaped the .catch, landed in the surrounding try/catch and showed
 * "Validation failed -- check your connection" AFTER the server action had succeeded: the officer never reached the checkpoint.
 */
test("a scanner that is not running (stop() throws synchronously) never blocks navigation", async () => {
  const notRunning = { isScanning: false, stop() { throw "Cannot stop, scanner is not running or paused."; } };
  await assert.doesNotReject(async () => stopScannerSafely(notRunning));
  const stillStarting = { isScanning: true, stop() { throw "Cannot stop, scanner is not running or paused."; } };
  await assert.doesNotReject(async () => stopScannerSafely(stillStarting), "even a synchronous throw while isScanning is true");
  const rejecting = { isScanning: true, stop: () => Promise.reject(new Error("camera busy")) };
  await assert.doesNotReject(async () => stopScannerSafely(rejecting));
});

test("a running scanner is stopped exactly once; a missing scanner is a no-op", async () => {
  let calls = 0;
  await stopScannerSafely({ isScanning: true, stop: async () => { calls += 1; } });
  assert.equal(calls, 1);
  let skipped = 0;
  await stopScannerSafely({ isScanning: false, stop: async () => { skipped += 1; } });
  assert.equal(skipped, 0, "a scanner that is not scanning is not stopped");
  await assert.doesNotReject(async () => stopScannerSafely(null));
  await assert.doesNotReject(async () => stopScannerSafely(undefined));
});

test("the scan screen uses the safe helper before navigating and no unguarded stop() remains on the success path", () => {
  const src = fs.readFileSync("components/scan/UnifiedScanner.tsx", "utf8");
  assert.match(src, /import \{ stopScannerSafely \} from "@\/lib\/icms\/scanner-stop"/);
  const resolve = src.slice(src.indexOf("const resolveAndGo"), src.indexOf("useEffect("));
  assert.match(resolve, /await stopScannerSafely\(scannerRef\.current\)/);
  assert.ok(resolve.indexOf("stopScannerSafely") < resolve.indexOf("router.push"), "the scanner is released before navigating");
  assert.doesNotMatch(resolve, /scannerRef\.current\?\.stop\(\)/);
});
