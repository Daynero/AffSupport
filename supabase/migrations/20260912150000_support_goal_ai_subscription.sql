-- Point the one published goal at what actually slows Soty down.
--
-- The Apple Developer Program removes a real annoyance, but it is an annoyance
-- people already work around. Waiting weeks for a bug fix is the thing they
-- cannot work around, and the bottleneck there is diagnosis time rather than
-- money for a certificate.
--
-- The existing row is updated rather than archived in favour of a new one, so
-- the amount already contributed stays with the project instead of resetting to
-- zero. The seed migration is updated alongside it so fresh environments start
-- with the same copy.
update public.support_goals
set
  slug = 'ai-subscription-faster-fixes',
  target_cents = 10000,
  title_en = 'Faster fixes',
  title_uk = 'Швидші виправлення',
  description_en =
    'I build Soty alone, in my own time. The slow part is not writing the fix — it is finding the cause: reproducing the bug, working through theories, making sure that mending one thing did not break another.

An AI subscription cuts exactly that part out. Something that waits weeks today gets fixed in an evening, and what is left over goes into new tools instead of patching old ones.

The goal is $100 — one month of it. Any amount moves it, however small, and at this size every single one genuinely counts. Please chip in if Soty is worth it to you.',
  description_uk =
    'Soty я роблю сам, у вільний час. Найдовше забирає не саме виправлення, а пошук причини: відтворити баг, перебрати гіпотези, переконатися, що, полагодивши одне, не зламав інше.

Саме цей шматок і зрізає ШІ-підписка. Те, що зараз чекає тижнями, встигає полагодитися за вечір, а час, який лишається, іде на нові інструменти, а не на латання старих.

Ціль — $100, це один місяць. Наближає будь-яка сума, навіть найменша: на таких обсягах кожна гривня справді має значення. Долучайтеся, будь ласка, якщо Soty того вартий.'
where slug = 'mac-updates-apple-developer';
