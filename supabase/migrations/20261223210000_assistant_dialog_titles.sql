-- 064: a dialog started before dialogs had titles is named, like every later one, by the
-- beginning of its first message; the list no longer calls it «Новий діалог». Idempotent.
update private.assistant_conversations c
set title = left(regexp_replace(btrim(m.text), '\s+', ' ', 'g'), 80)
from (
  select distinct on (x.conversation_id) x.conversation_id, x.text
  from private.assistant_messages x
  where x.role = 'user'
  order by x.conversation_id, x.id
) m
where m.conversation_id = c.id and c.title is null;
