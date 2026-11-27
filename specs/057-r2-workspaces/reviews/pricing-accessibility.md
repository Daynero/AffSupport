# Pricing amendment review — accessible-v2

2026-11-14. Owner directed a permanent $5 Solo entry, smaller packages and inexpensive space expansion. Existing implementation prohibition retained; only design artifacts changed.

## Decisions

- Six bundles:5/9/15/29/59/119 USD monthly; capacities10/50/100/200/500/1000GB, people1/1/3/5/10/20, spaces1/2/3/5/10/20.
- Any base grows through independent10GB/$1, person/$2, space/$1 increments; larger storage denominations remain available. No2x-base restriction; globally qualified workload ceilings remain.
- Object capacity grows with storage at200 objects/GB, capped1m/org and100k/space. A new space does not multiply storage or people.
- Same core features, protection, diagnostics and export. Permanent monthly$5 is not annual-only promotional bait.

## Findings and resolutions

| ID  | Severity | Finding                                                              | Resolution                                                                                                                            |
| --- | -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | HIGH     | Simply lowering$29 to$5 with old$3 allowance cannot meet55% margin   | label lower$0.80 allowance an automation efficiency target, preserve$3/$5 stress, measured support/API cost gate; no invented savings |
| P2  | MEDIUM   | 6x$5 and1x$30 have equal revenue but different cost                  | match60GB/6people/6spaces/3M reads; six contribution18.16 vs one22.53 before fixed/CAC; do not assert automatic superiority           |
| P3  | MEDIUM   | Small storage plans still include500k requests                       | include per-org request floor in formula at every occupancy                                                                           |
| P4  | HIGH     | Separate prorated$0.10 add-on payment loses money on fixed fee       | consolidate invoice, no separate settlement below$1, explicit scheduling/bundling; show immediate-payment stress separately           |
| P5  | MEDIUM   | Old per-plan object counts and2x ceiling defeat flexible Solo growth | derive object budget from total storage, preserve global proof limits and qualified add-on acceptance                                 |
| P6  | MEDIUM   | Trial3people cannot silently become Solo1person                      | explicit quote for extra seats or owner removal of access; no silent member/data deletion                                             |

## Verification

Recomputed36 plan occupancy/term scenarios,14 marginal add-on scenarios and84 actual base-plus-addon scenarios. All normative consolidated full-occupancy monthly scenarios meet55%, annual45%, under stated new cost targets. Six-versus-one arithmetic isolates$4.375 extra org/payment overhead. Solo shared-fixed break-even50–100 paying accounts for$150–300 estimate; registered users are not payers. CAC ceiling/payback explicitly excludes fixed/churn and is not a marketing forecast.

Spec US4/FR019/SC008, plan, quote contract, data model, README, tasks T029/T030/T036/T037 and final analysis synchronized. Still34 FR +10 SC,72 unchecked implementation tasks. Formatting, JSON arithmetic, task coverage and local links checked. No production plan changes, payments, provisioning, software implementation or new analytics queries executed for this amendment.

No remaining identified contradiction in this amendment. Actual automation cost, provider invoices, host bandwidth, metadata/restore cost and paid-cohort conversion/retention remain measured launch gates; modeled margin is not demonstrated net profit.
