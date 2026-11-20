-- fork: deterministicJson caches (PLAN.md Phase 13) in the main DB. Applied by
-- `scripts/fork/state.sh init`; safe to run again. Mirrors
-- apps/api/src/db/schema/public.ts (deterministic_json_scripts, _llm_cache).
CREATE TABLE IF NOT EXISTS public.deterministic_json_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cache_key text NOT NULL UNIQUE,
  code text NOT NULL, url text, model text, cache_version integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.deterministic_json_llm_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cache_key text NOT NULL UNIQUE,
  response text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now());
