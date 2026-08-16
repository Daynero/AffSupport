-- Keep the already-published donation copy aligned with the Soty brand.
-- The original seed migration is also updated so fresh environments start
-- with the correct text.
update public.support_goals
set
  description_en = 'Right now, every update means downloading the DMG again and going through the same manual ritual. The $99 goal covers the first year of the Apple Developer Program. That will let me sign and notarize Soty, then add safe updates directly inside the app — without repeated downloads, manual replacement, or Terminal commands.',
  description_uk = 'Зараз кожне оновлення означає знову завантажити DMG, і інші танці з бубном. Щоб це прибрати, потрібні $99 на перший рік Apple Developer Program. Це дозволить підписувати й нотаризувати Soty, а далі — зробити безпечне оновлення прямо із застосунку: без повторних завантажень, ручної заміни та команд у Terminal.'
where slug = 'mac-updates-apple-developer';
