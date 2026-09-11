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
        className="fixed bottom-20 right-6 z-40 flex items-center gap-2 rounded-full bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2.5 text-xs font-bold text-black shadow-lg shadow-cyan-500/20 transition-all duration-300 hover:scale-105 hover:shadow-cyan-500/40 hover:from-cyan-400 hover:to-blue-500 active:scale-95 border border-cyan-300/40"
        title="Open W.O.I.S AI Assistant"
      >
        <Sparkles className="h-4 w-4 fill-black/20 text-black" />
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
