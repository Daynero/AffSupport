# Contract: розподіл копій і варіацій (`packages/shared/src/team/launches/creative-distribution.ts`)

Чисті детерміновані функції без часу й випадковості. Використовуються редактором, `parseLaunchConfig`, edge-плануванням і тестами властивостей.

```ts
evenCopies(n: number, k: number): number[]
// ⌊n/k⌋ кожному, залишок по одному першим. Передумова 1 ≤ k ≤ n.
// evenCopies(100,3) = [34,33,33]

dragCopies(list: LaunchCreative[], index: number, value: number, n: number): LaunchCreative[]
// Повзунок. value обмежується [1, n-(k-1)]. Δ компенсується пропорційно ВСІМА іншими
// (найбільший залишок, кожен ≥1). Усі pinned = null. Сума завжди n.
// dragCopies(25×4, 0, 40, 100) = [40,20,20,20]

setCopies(list: LaunchCreative[], index: number, value: number, n: number): LaunchCreative[]
// Поле вводу.
// value обмежується [1, n-(k-1)]. list[index].pinned = max(pinned)+1.
// Δ = value - old компенсується серед pinned===null (крім index) пропорційно поточним копіям,
// найбільший залишок, кожен ≥1. Якщо їх немає або вони вичерпані до 1 — далі від pinned
// з найменшим pinned (найдавніше редагований), по одному, доки Δ не закрито.
// Якщо Δ не закривається — value зменшується до досяжного. Сума завжди n.

rescaleCopies(list: LaunchCreative[], n: number): LaunchCreative[]
// Якщо поточний розподіл = evenCopies(old n, k) → evenCopies(n, k).
// Інакше пропорційно (найбільший залишок), кожен ≥1, сума n. pinned зберігаються.

removeCreative(list: LaunchCreative[], index: number, n: number): LaunchCreative[]
// Копії видаленого розподіляються як Δ у setCopies (без нового pinned).

balanceCopies(list: LaunchCreative[], n: number): LaunchCreative[]
// evenCopies, усі pinned = null.

distributeVariations(copies: number[], total: number): number[]
// Передумова k ≤ total ≤ Σcopies. Кожен отримує 1, далі по колу i = 0..k-1,
// пропускаючи i з variants[i] === copies[i].
// distributeVariations([25,25,25,25],30) = [8,8,7,7]
// distributeVariations([40,30,20,10],100) = [40,30,20,10]

isValidDistribution(copies: number[], n: number): boolean  // k = copies.length

addCreatives(list, added, n): { creatives, productCount }
// дедуп за materialId; productCount = max(n, k'); рівний лишається рівним,
// у нерівному новачок отримує рівну частку, решта компенсують (як setCopies).
```

## Властивості (тест SC-006)

Для 10 000 випадкових послідовностей операцій (`dragCopies`, `setCopies`, `rescaleCopies`, `removeCreative`, `balanceCopies`) при `1 ≤ k ≤ 400`, `k ≤ n ≤ 400` (+ `addCreatives`):
- `Σ copies = n`, кожен `≥ 1`;
- `setCopies` ніколи не змінює значення pinned-креативу, якщо є незакріплені з запасом;
- `distributeVariations`: `Σ = total`, `1 ≤ v[i] ≤ copies[i]`, `max−min ≤ 1` серед ненасичених.
