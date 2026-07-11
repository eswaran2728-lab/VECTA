import { WifiOff } from "lucide-react";

export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <WifiOff className="h-12 w-12 text-muted-foreground" />
      <h1 className="text-xl font-bold">You are offline</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Checkpoint submissions made while offline are saved on this device and will sync
        automatically when the connection returns. Pages you visited recently remain available
        from the cache.
      </p>
    </main>
  );
}
