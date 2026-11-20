-- fork: local scrape index (PLAN.md Phase 10, D10). Applied by
-- `scripts/fork/state.sh init`; safe to run again.
-- Columns mirror apps/api/src/db/schema/index-db.ts. The repo ships no DDL or
-- SQL functions for the index, so index_get_recent_5 is written from the
-- documented filters in apps/api/src/services/index-cache.ts
-- (deriveIndexVariantKey, filterIndexEntries).

CREATE TABLE IF NOT EXISTS public.index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  url text NOT NULL,
  url_hash bytea NOT NULL,
  original_url text NOT NULL,
  resolved_url text NOT NULL,
  has_screenshot boolean NOT NULL,
  has_screenshot_fullscreen boolean NOT NULL,
  is_mobile boolean NOT NULL,
  block_ads boolean NOT NULL,
  location_country text,
  location_languages text[],
  status integer NOT NULL,
  title text,
  description text,
  invalidated_at timestamptz,
  is_precrawl boolean,
  wait_time_ms bigint,
  is_stealth boolean NOT NULL DEFAULT false,
  url_split_0_hash bytea NOT NULL,
  url_split_1_hash bytea,
  url_split_2_hash bytea,
  url_split_3_hash bytea,
  url_split_4_hash bytea,
  url_split_5_hash bytea,
  url_split_6_hash bytea,
  url_split_7_hash bytea,
  url_split_8_hash bytea,
  url_split_9_hash bytea,
  domain_splits_0_hash bytea,
  domain_splits_1_hash bytea,
  domain_splits_2_hash bytea,
  domain_splits_3_hash bytea,
  domain_splits_4_hash bytea
);

CREATE INDEX IF NOT EXISTS index_url_hash_created_at
  ON public.index (url_hash, created_at DESC);

-- Newest five usable copies of a URL for one request variant: exact match on
-- device, ad blocking, stealth and country; languages compared as sets (NULL
-- and an empty list differ); inside [now - max_age, now - min_age]; a copy
-- with a screenshot when one is asked for; waited at least as long.
CREATE OR REPLACE FUNCTION public.index_get_recent_5(
  p_url_hash bytea,
  p_max_age_ms bigint,
  p_is_mobile boolean,
  p_block_ads boolean,
  p_feature_screenshot boolean,
  p_feature_screenshot_fullscreen boolean,
  p_location_country text,
  p_location_languages text[],
  p_wait_time_ms bigint,
  p_is_stealth boolean,
  p_min_age_ms bigint
) RETURNS TABLE (
  id uuid,
  created_at timestamptz,
  status integer,
  has_screenshot boolean,
  has_screenshot_fullscreen boolean,
  wait_time_ms bigint
) LANGUAGE sql STABLE AS $$
  SELECT i.id, i.created_at, i.status, i.has_screenshot,
         i.has_screenshot_fullscreen, i.wait_time_ms
  FROM public.index i
  WHERE i.url_hash = p_url_hash
    AND i.invalidated_at IS NULL
    AND i.is_mobile = p_is_mobile
    AND i.block_ads = p_block_ads
    AND i.is_stealth = p_is_stealth
    AND i.location_country IS NOT DISTINCT FROM p_location_country
    AND (
      (p_location_languages IS NULL AND i.location_languages IS NULL)
      OR (i.location_languages @> p_location_languages
          AND i.location_languages <@ p_location_languages)
    )
    AND i.created_at >= now() - p_max_age_ms * interval '1 millisecond'
    AND (p_min_age_ms IS NULL
         OR i.created_at <= now() - p_min_age_ms * interval '1 millisecond')
    AND (NOT p_feature_screenshot OR i.has_screenshot)
    AND (NOT p_feature_screenshot_fullscreen OR i.has_screenshot_fullscreen)
    AND COALESCE(i.wait_time_ms, 0) >= COALESCE(p_wait_time_ms, 0)
  ORDER BY i.created_at DESC
  LIMIT 5;
$$;
