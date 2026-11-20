-- 062 additive closed vocabulary: refusals of Launches with several creatives and image creatives.
-- Existing applied error code migrations stay immutable.
insert into public.team_error_codes(code) values
  ('CREATIVES_MIXED'),
  ('CREATIVES_LIMIT'),
  ('CREATIVE_DUPLICATE'),
  ('DISTRIBUTION_INVALID'),
  ('VARIATIONS_RANGE'),
  ('CREATIVE_IMAGE_FORMAT'),
  ('CREATIVE_IMAGE_TOO_LARGE'),
  ('PUBLIC_READ_UNVERIFIED'),
  ('MULTI_CREATIVE_UNSUPPORTED')
on conflict(code) do nothing;
