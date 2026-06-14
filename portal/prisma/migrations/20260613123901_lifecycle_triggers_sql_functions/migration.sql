-- KAIA-1177 — lifecycle triggers (KAIA-1172 / AU-2) backend support.
--
-- Adds the SQL infrastructure the four new portal routes need:
--
--   1. business_hours_elapsed(start_ts, end_ts, tz)
--      Counts business hours between two timestamps in the operator's
--      timezone, treating 09:00–18:00 weekdays (Mon–Fri) as hábiles.
--      Used by the review-overdue/scan route to compute the 24h/48h
--      hábiles SLA in a single round trip.
--
--   2. operator_day_in_tz(now_ts, tz)
--      Returns the YYYY-MM-DD date key in the operator's timezone for
--      the "day" column on OperatorNotification rows. The review-overdue
--      dedup is per (clientId, kind, day) but the day key must respect
--      the operator's working timezone, not UTC — otherwise a Friday-evening
--      review in Madrid and a Saturday-morning re-fire would land on the
--      same "day" and silently dedup the wrong way. UTC keying is fine
--      for the existing operator-notify kinds; review-overdue needs
--      operator-local day keys.
--
--   3. wizard_abandoned_window(now_ts)
--      Helper that returns the wizard-abandoned threshold (now - 48h).
--      Keeps the SQL in the scan route readable.
--
-- Reversibility: the rollback drops the three functions. None of them
-- are referenced by existing migrations.

-- ---------------------------------------------------------------------------
-- business_hours_elapsed
-- ---------------------------------------------------------------------------
-- Counts business hours from `start_ts` to `end_ts` in the operator's
-- timezone, treating 09:00–18:00 weekdays (Mon–Fri) as hábiles.
--
-- Semantics (end-exclusive):
--   * The work window is [09:00, 18:00) on weekdays (Mon–Fri). 18:00
--     is the END of the work day — no time spent working AT 18:00.
--   * `end_ts` is exclusive. From Mon 09:00 to Tue 18:00 the function
--     returns 9h hábiles (the full Monday work window; Tuesday
--     contributes 0h because we stop at 18:00 exclusive).
--   * From Fri 17:00 to Mon 09:00 the function returns 1h hábiles
--     (the leftover hour of Friday's work window). The intermediate
--     weekend is correctly excluded.
--
-- The smoke test in scripts/smoke-review-overdue.ts exercises the
-- three unit cases documented in the issue's acceptance criteria and
-- must stay in lockstep with this function — drift between the JS
-- port and the SQL is a contract violation.
--
-- Algorithm:
--   1. Convert both timestamps to the operator's timezone.
--   2. If start and end are on the same calendar day:
--        a. If weekday and the interval overlaps the work window,
--           return (min(end,18:00) - max(start,09:00)) in hours
--           (the result is 0 if min(end,18:00) <= max(start,09:00),
--           which is the natural "end is exclusive" case when end is
--           exactly 18:00).
--        b. Otherwise return 0.
--   3. Otherwise, count:
--        - First day: from max(start,09:00) to 18:00 of the same day.
--        - Middle days: 9h per full weekday strictly between.
--        - Last day: from 09:00 to min(end,18:00) of the same day.
--          If end is exactly 18:00, the contribution is 0.
-- ---------------------------------------------------------------------------
create or replace function public.business_hours_elapsed(
  start_ts timestamptz,
  end_ts timestamptz,
  tz text
)
returns numeric
language plpgsql
immutable
as $$
declare
  start_local timestamp;
  end_local   timestamp;
  start_date  date;
  end_date    date;
  cursor_date date;
  day_start   timestamp;
  day_end     timestamp;
  total_hours numeric := 0;
  is_weekday  boolean;
begin
  if start_ts >= end_ts then
    return 0;
  end if;

  start_local := start_ts at time zone tz;
  end_local   := end_ts   at time zone tz;
  start_date  := start_local::date;
  end_date    := end_local::date;

  -- Same-day case.
  if start_date = end_date then
    is_weekday := extract(isodow from start_date) between 1 and 5;
    if is_weekday then
      day_start := start_date::timestamp + time '09:00';
      day_end   := start_date::timestamp + time '18:00';
      -- The work window is [day_start, day_end). end_local must be
      -- STRICTLY inside the work window (end > day_start) and
      -- start_local must be strictly before the work window end
      -- (start < day_end). With end exclusive, end == day_end gives
      -- a zero-length slice.
      if end_local > day_start and start_local < day_end then
        total_hours := total_hours
          + extract(epoch from (least(end_local, day_end) - greatest(start_local, day_start))) / 3600.0;
      end if;
    end if;
    return total_hours;
  end if;

  -- First day: count from max(start, 09:00) to 18:00 of the same day.
  is_weekday := extract(isodow from start_date) between 1 and 5;
  if is_weekday then
    day_start := start_date::timestamp + time '09:00';
    day_end   := start_date::timestamp + time '18:00';
    if start_local < day_end then
      total_hours := total_hours
        + extract(epoch from (day_end - greatest(start_local, day_start))) / 3600.0;
    end if;
  end if;

  -- Full weekdays strictly between start_date and end_date.
  cursor_date := start_date + 1;
  while cursor_date < end_date loop
    is_weekday := extract(isodow from cursor_date) between 1 and 5;
    if is_weekday then
      total_hours := total_hours + 9;
    end if;
    cursor_date := cursor_date + 1;
  end loop;

  -- Last day: count from 09:00 to min(end, 18:00) of the same day.
  -- When end is exactly 18:00 (i.e. the work window just ended), the
  -- slice is zero and we correctly contribute 0 hábiles. We require
  -- end_local to be STRICTLY inside the work window (end_local <
  -- day_end) so the zero-length slice is excluded.
  is_weekday := extract(isodow from end_date) between 1 and 5;
  if is_weekday then
    day_start := end_date::timestamp + time '09:00';
    day_end   := end_date::timestamp + time '18:00';
    if end_local > day_start and end_local < day_end then
      total_hours := total_hours
        + extract(epoch from (least(end_local, day_end) - day_start)) / 3600.0;
    end if;
  end if;

  return total_hours;
end;
$$;

revoke all on function public.business_hours_elapsed(timestamptz, timestamptz, text) from public;
grant execute on function public.business_hours_elapsed(timestamptz, timestamptz, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- operator_day_in_tz
-- ---------------------------------------------------------------------------
create or replace function public.operator_day_in_tz(
  now_ts timestamptz,
  tz text
)
returns text
language sql
immutable
as $$
  select to_char(now_ts at time zone tz, 'YYYY-MM-DD');
$$;

revoke all on function public.operator_day_in_tz(timestamptz, text) from public;
grant execute on function public.operator_day_in_tz(timestamptz, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- wizard_abandoned_window
-- ---------------------------------------------------------------------------
create or replace function public.wizard_abandoned_window(
  now_ts timestamptz,
  window_hours integer
)
returns timestamptz
language sql
immutable
as $$
  select now_ts - (window_hours::text || ' hours')::interval;
$$;

revoke all on function public.wizard_abandoned_window(timestamptz, integer) from public;
grant execute on function public.wizard_abandoned_window(timestamptz, integer) to authenticated, service_role;
