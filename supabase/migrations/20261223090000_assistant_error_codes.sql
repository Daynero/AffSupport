-- 064: the closed error codes of credits and the launch assistant (TEAM_ASSISTANT_ERROR_CODES), in
-- the same order as packages/shared/src/team/transport.ts; tests/team-contract.test.ts compares the two.

insert into public.team_error_codes (code) values
  ('INSUFFICIENT_CREDITS'),
  ('AI_MONTH_EXHAUSTED'),
  ('PRICE_CHANGED'),
  ('CLIENT_UPGRADE'),
  ('ASSISTANT_DISABLED'),
  ('ASSISTANT_FORBIDDEN'),
  ('MESSAGE_TOO_LONG'),
  ('MODEL_UNAVAILABLE'),
  ('MODEL_OUTPUT_REJECTED'),
  ('PLAN_TOO_LARGE'),
  ('REVIEW_CHANGED'),
  ('EDIT_CONFLICT'),
  ('KEY_REUSED')
on conflict (code) do nothing;
