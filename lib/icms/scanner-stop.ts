/**
 * Releases the camera scanner without ever blocking the caller.
 *
 * html5-qrcode's stop() THROWS SYNCHRONOUSLY (a string) when the scanner is not currently scanning -- camera unavailable, permission
 * denied, still starting, or never started -- so `scanner.stop().catch(...)` does not protect the caller. A manual-entry officer whose
 * camera is not running must still reach the checkpoint after the server has validated the reference, so every failure here is swallowed.
 */
export interface StoppableScanner {
  isScanning?: boolean;
  stop(): Promise<void>;
}

export async function stopScannerSafely(scanner: StoppableScanner | null | undefined): Promise<void> {
  if (!scanner || !scanner.isScanning) return;
  try {
    await scanner.stop();
  } catch {
    // not running / already stopping / camera busy: nothing to release, navigation must proceed
  }
}
