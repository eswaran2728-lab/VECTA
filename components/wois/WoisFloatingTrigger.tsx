"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { WoisChatModal } from "./WoisChatModal";

export function WoisFloatingTrigger({
  userContext,
}: {
  userContext?: {
    role?: string | null;
    ops_group?: string | null;
    station?: string | null;
    team?: string | null;
  };
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      {/* Floating Action Button */}
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-20 right-6 z-40 flex items-center gap-2 rounded-full bg-primary px-4 py-2.5 text-xs font-bold text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-300 hover:scale-105 hover:shadow-primary/40 active:scale-95 border border-primary/40 cursor-pointer"
        title="Open W.O.I.S AI Assistant"
      >
        <Sparkles className="h-4 w-4" />
        <span className="font-display tracking-wider">AI</span>
      </button>

      {/* Interactive Modal */}
      <WoisChatModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        userContext={userContext}
      />
    </>
  );
}
