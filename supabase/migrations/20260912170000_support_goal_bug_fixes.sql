-- Say what the money is for in the words the owner uses, and ask for a figure
-- that can actually be reached.
--
-- $100 is a month of the subscription and reads, at zero raised, as a wall; $25
-- is a week of it and moves visibly on a single contribution. The description
-- loses the explanation of why diagnosis is slow — the people reading it have
-- been waiting on those fixes and already know — and keeps the two sentences
-- that say who builds this and what the money does.
--
-- The row is updated rather than replaced, so anything already contributed
-- stays with the project instead of resetting to zero.
update public.support_goals
set
  slug = 'ai-tools-bug-fixes',
  target_cents = 2500,
  title_en = 'For bug fixes',
  title_uk = 'На баг фікс',
  description_en =
    'I build Soty alone, in my own time.

So your support for AI tools really matters to me. Every contribution is a simple thank-you for the work. Thanks in advance to everyone who cares <3',
  description_uk =
    'Soty я роблю сам, у вільний час.

Тому ваша підтримка на ШІ інструменти мені дуже потрібна. Кожна гривня це проста вдячність за мою роботу. Завчасно дякую всім не байдужим <3'
where slug in ('ai-subscription-faster-fixes', 'mac-updates-apple-developer');
