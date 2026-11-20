-- fork: monitor tables in the main DB (PLAN.md Phase 12). Applied by
-- `scripts/fork/state.sh init`; safe to run again. Columns mirror
-- apps/api/src/db/schema/public.ts, except team_id is text: with auth off the
-- team is the string "bypass", not a uuid. monitoring_claim_due_monitors is
-- not in the repo; it is written from how scheduler.ts and store.ts use it.

CREATE TABLE IF NOT EXISTS public.monitors (
  id uuid PRIMARY KEY, team_id text NOT NULL, name text NOT NULL,
  status text NOT NULL DEFAULT 'active', schedule_cron text NOT NULL,
  schedule_timezone text NOT NULL DEFAULT 'UTC', next_run_at timestamptz, last_run_at timestamptz,
  last_check_id uuid, current_check_id uuid, locked_at timestamptz, locked_until timestamptz,
  retention_days integer NOT NULL DEFAULT 30, estimated_credits_per_month integer,
  targets jsonb NOT NULL DEFAULT '[]', webhook jsonb, notification jsonb, last_check_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz, goal text, judge_enabled boolean NOT NULL DEFAULT false, partner_job_token text);
CREATE INDEX IF NOT EXISTS monitors_due_idx ON public.monitors (status, next_run_at);
CREATE INDEX IF NOT EXISTS monitors_team_idx ON public.monitors (team_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.monitor_checks (
  id uuid PRIMARY KEY, monitor_id uuid NOT NULL, team_id text NOT NULL, trigger text NOT NULL,
  status text NOT NULL DEFAULT 'queued', scheduled_for timestamptz, started_at timestamptz, finished_at timestamptz,
  estimated_credits integer, reserved_credits integer, actual_credits integer, autumn_lock_id text, partner_run_token text,
  billing_status text NOT NULL DEFAULT 'not_applicable',
  total_pages integer NOT NULL DEFAULT 0, same_count integer NOT NULL DEFAULT 0, changed_count integer NOT NULL DEFAULT 0,
  new_count integer NOT NULL DEFAULT 0, removed_count integer NOT NULL DEFAULT 0, error_count integer NOT NULL DEFAULT 0,
  target_results jsonb, webhook_payload jsonb, email_payload jsonb, notification_status jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS monitor_checks_monitor_idx ON public.monitor_checks (monitor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS monitor_checks_status_idx ON public.monitor_checks (status, created_at, id);

CREATE TABLE IF NOT EXISTS public.monitor_check_pages (
  id uuid PRIMARY KEY, check_id uuid NOT NULL, monitor_id uuid NOT NULL, team_id text NOT NULL,
  target_id text NOT NULL, url text NOT NULL, url_hash bytea NOT NULL, status text NOT NULL,
  previous_scrape_id uuid, current_scrape_id uuid, diff_gcs_key text, diff_text_bytes integer, diff_json_bytes integer,
  status_code integer, error text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now(), judgment jsonb);
CREATE INDEX IF NOT EXISTS monitor_check_pages_check_idx ON public.monitor_check_pages (check_id, target_id, status);

CREATE TABLE IF NOT EXISTS public.monitor_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), monitor_id uuid NOT NULL, team_id text NOT NULL,
  target_id text NOT NULL, url text NOT NULL, url_hash bytea NOT NULL, source text NOT NULL,
  first_seen_check_id uuid, last_seen_check_id uuid, last_changed_check_id uuid, last_scrape_id uuid,
  last_status text NOT NULL, is_removed boolean NOT NULL DEFAULT false, removed_at timestamptz, metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (monitor_id, target_id, url_hash));

CREATE TABLE IF NOT EXISTS public.monitor_email_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), monitor_id uuid NOT NULL, team_id text NOT NULL,
  email text NOT NULL, status text NOT NULL DEFAULT 'pending', token text NOT NULL UNIQUE,
  source text NOT NULL DEFAULT 'opt_in', confirmation_sent_at timestamptz, confirmed_at timestamptz,
  unsubscribed_at timestamptz, last_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (monitor_id, email));

-- crawl_id/scrape_id as text: one malformed id would fail a whole batch insert.
CREATE TABLE IF NOT EXISTS public.webhook_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), success boolean NOT NULL, error text,
  team_id text NOT NULL, crawl_id text NOT NULL, scrape_id text,
  created_at timestamptz NOT NULL DEFAULT now(), url text NOT NULL, status_code smallint,
  event text NOT NULL, latency_ms integer DEFAULT 0);
CREATE INDEX IF NOT EXISTS webhook_logs_job_idx ON public.webhook_logs (crawl_id, event, created_at DESC);

-- Claim due, unlocked, active monitors for one lease (p_worker_id unused:
-- the table has no locked_by column).
CREATE OR REPLACE FUNCTION public.monitoring_claim_due_monitors(
  p_worker_id text, p_limit integer, p_lease_seconds integer)
RETURNS SETOF public.monitors LANGUAGE sql AS $$
  UPDATE public.monitors m
     SET locked_at = now(), locked_until = now() + make_interval(secs => p_lease_seconds)
   WHERE m.id IN (SELECT id FROM public.monitors
                   WHERE status = 'active' AND next_run_at <= now()
                     AND (locked_until IS NULL OR locked_until <= now())
                   ORDER BY next_run_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  RETURNING m.*;
$$;
