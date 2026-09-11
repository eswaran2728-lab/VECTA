-- Migration: 20260911000008_wois_ai_knowledge_base.sql
-- W.O.I.S AI (Work Order Intelligence Smartbook) V1 Schema

-- 1. Knowledge Base Documents Table
CREATE TABLE IF NOT EXISTS public.kb_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('sop', 'regulatory', 'app_help')),
  version TEXT NOT NULL DEFAULT '1.0',
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Knowledge Base Chunks Table
CREATE TABLE IF NOT EXISTS public.kb_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES public.kb_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  section_title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('sop', 'regulatory', 'app_help')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. W.O.I.S Conversations Table (User Chat Sessions)
CREATE TABLE IF NOT EXISTS public.wois_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New Chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. W.O.I.S Messages Table (Chat Message History)
CREATE TABLE IF NOT EXISTS public.wois_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.wois_conversations(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant')),
  body TEXT NOT NULL,
  confidence_tag TEXT CHECK (confidence_tag IN ('VERIFIED', 'GENERAL_KNOWLEDGE', 'REQUIRES_SOP', 'UNCERTAIN', 'ESCALATE')),
  source_type TEXT CHECK (source_type IN ('sop', 'regulatory', 'app_help', 'general')),
  sources JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.kb_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wois_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wois_messages ENABLE ROW LEVEL SECURITY;

-- RLS: Knowledge Base is readable by all authenticated users
CREATE POLICY kb_documents_read_auth ON public.kb_documents
  FOR SELECT TO authenticated USING (true);

CREATE POLICY kb_chunks_read_auth ON public.kb_chunks
  FOR SELECT TO authenticated USING (true);

-- RLS: Conversations are accessible only by the owning user
CREATE POLICY wois_conversations_user_all ON public.wois_conversations
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- RLS: Messages are accessible only if the user owns the parent conversation
CREATE POLICY wois_messages_user_all ON public.wois_messages
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.wois_conversations c
      WHERE c.id = wois_messages.conversation_id AND c.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.wois_conversations c
      WHERE c.id = wois_messages.conversation_id AND c.user_id = auth.uid()
    )
  );

-- Indexes for fast query retrieval
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON public.kb_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON public.kb_chunks(source_type);
CREATE INDEX IF NOT EXISTS idx_wois_conv_user ON public.wois_conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_wois_msg_conv ON public.wois_messages(conversation_id, created_at ASC);
