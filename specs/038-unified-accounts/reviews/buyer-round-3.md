# Buyer review — round 3

Date: 2026-10-18. Independent buyer, actual local beta, dedicated Chrome tab766198378. **Score: 97/100 for exercised desktop buyer workflow.** This is a usability/functionality review, not certification of every platform, finance failure mode or release gate.

## Fixed and directly retested

- Archive801 with recorded today101/50/5 and yesterday11 now leaves accessible history/copy controls. History semantic click succeeds. Dated historical correction17.10.2026 changed spend11→16 and table reflected16 while801 remained archived; today's spend5/topup120 stayed unchanged.
- Active/free counts fell8→7 after archiving801; BUYER038 header correctly shows4active/4free. Selecting “Вільні7” removes archived801; returning “Усі7” retains its financial row.

## Additional actual buyer scenarios

- Created socialBUYER038R3 with RK88003901/902/903.
-901: no financial data; archive removes it from today.
-902: only yesterday spend9; archive removes it from today but yesterday displays902 with recorded9. Yesterday data does not retain it today.
-903: explicit saved today balance0; archive retains it today with visible0 and “В архіві”. Parent says “Немає активних РК”, not three available RK.
- ParentBUYER038 archived while801 was already independently archived. Archive lists child restore controls disabled with explicit “Спочатку відновіть батьківський соц.” Restored onlyBUYER038:802/803/805/804 returned active,801 stayed independently archived with financial history.
- Manual order from round2 remained801/802/803/805/804 through date switches, parent archive/restore and finance mutation. Assigned manual launch“BUYER-R3 RUN” to805; saved state became launched, header4active/3free/1launched;805 stayed before804. No status resort.
- Previous round's full5-RK daily input, exact clipboard50/70, persistence and split totals remain verified evidence; this round added real archive edge cases rather than assuming them.

## Minor improvements (3 points deducted)

1. **History context label loses account name:** drawer title is“Історія · -801” although events and originating control correctly identifyBUYER038. Historical correction input labels use internal UUID instead of social/RK identity. Dates and values are unambiguous, but this is distracting and worse for assistive technology. Use retained account/RK identity.
2. **Inline create form can sit under sticky column captions after auto-scroll:** during creation at1384×666 the top of social-name input was obscured. Save remains reachable and creation succeeds, but align scroll position so identity/error context is wholly visible.

Designer independently owns responsive review; their discovered mobile Save overflow is not certified fixed here and should be addressed before overall acceptance. Browser viewport changes by the other review briefly altered this tab; subsequent tests ran after designer reset/stopped viewport changes.

## Evidence limits

No measured500-row pointer performance or live midnight waiting; no simulated offline/lost response, permission revocation or concurrent clients in this review. No new claim about automated diagnostics from source reading. No product code modified. Local test state:BUYER038active parent,801archived,805has test launch;R3three child cases archived,903retained as explicit0 today.
