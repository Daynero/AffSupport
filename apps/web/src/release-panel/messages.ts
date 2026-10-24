/** Operator-only strings; kept separate from parallel product i18n work. */
export const messages = {
  title: 'Реліз Soty',
  loading: 'Підключення до контролера…',
  connected: 'Підключено',
  reconnecting: 'Зв’язок втрачено — перепідключення',
  unavailable:
    'Панель недоступна. Візьми нове посилання: release:controller panel або release:panel:watch.',
  progress: 'За підтвердженими етапами, не за часом очікування',
  stale: 'Дані воркера застаріли. Це не доказ, що реліз зупинився.',
  steps: 'Етапи релізу',
  details: 'Деталі',
  logs: 'Журнал',
  tokens: 'Токени ремонту',
  unknown: 'Невідомо',
  attempts: 'Спроби ремонту',
  monitoring: 'Моніторинг не викликає модель',
  candidates: 'Кандидати',
  observing: 'Прогрес оновлюється автоматично',
  cancel: 'Скасувати реліз',
  keep: 'Продовжити виконання',
  cancelBody:
    'Нові етапи та ремонти не запускатимуться. Поточна зовнішня дія спочатку безпечно завершиться або буде звірена.',
  states: {
    accepted: 'Підготовка релізу',
    running: 'Виконується',
    waiting: 'Очікування',
    repairing: 'Агент виправляє',
    validating: 'Незалежна перевірка',
    needs_owner: 'Потрібна дія власника',
    cancelling: 'Зупинка на безпечній межі',
    cancelled: 'Скасовано',
    completed: 'Реліз перевірено й завершено'
  },
  stepNames: {
    preflight: 'Передумови',
    prepare: 'Підготовка',
    candidate_gate: 'Перевірка релізу',
    beta_package: 'Пакування beta',
    beta_verify: 'Перевірка beta',
    backend_beta: 'Перевірка серверних змін',
    readiness: 'Готовність до публікації',
    macos_package: 'Пакування macOS',
    windows_smoke: 'Windows: перевірка',
    publish: 'Публікація застосунку',
    manifest: 'Підготовка оновлення',
    manifest_beta_verify: 'Перевірка оновлення',
    backend_apply: 'Оновлення сервера',
    deploy: 'Оновлення сайту',
    live_verify: 'Фінальна перевірка'
  } as Record<string, string>,
  stepStates: {
    completed: 'Підтверджено',
    running: 'Виконується',
    pending: 'Попереду',
    excluded: 'Не застосовується'
  } as Record<string, string>
};
