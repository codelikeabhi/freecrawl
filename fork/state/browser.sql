-- fork: browser sessions (PLAN.md Phase 14) in the main DB. Applied by
-- `scripts/fork/state.sh init`; safe to run again. Mirrors browser_sessions in
-- apps/api/src/db/schema/public.ts (team_id text: the local team is "bypass").
CREATE TABLE IF NOT EXISTS public.browser_sessions (
  id uuid PRIMARY KEY, zero_data_retention boolean NOT NULL DEFAULT false,
  team_id text NOT NULL, request_id uuid, should_bill boolean NOT NULL DEFAULT true,
  browser_id text NOT NULL, workspace_id text NOT NULL, context_id text NOT NULL,
  cdp_url text NOT NULL, cdp_path text NOT NULL, stream_web_view boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active', ttl_total integer NOT NULL, ttl_without_activity integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz, credits_used integer, cdp_interactive_path text, scrape_id uuid,
  profile_name text);
CREATE INDEX IF NOT EXISTS browser_sessions_scrape_idx ON public.browser_sessions (scrape_id, created_at DESC);
CREATE INDEX IF NOT EXISTS browser_sessions_team_idx ON public.browser_sessions (team_id, status, created_at DESC);
