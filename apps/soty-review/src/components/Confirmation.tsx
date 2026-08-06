import { Action } from './Action';

export function Confirmation({ onConfirm }: { onConfirm: () => void }) {
  return (
    <div className="soty-confirmation" role="alert">
      <strong>Підтвердити демонстраційну дію?</strong>
      <p>
        Ціль: вибрані локальні приклади. Наслідок: лише показ наступного UI-стану; файли та акаунт
        не змінюються.
      </p>
      <Action variant="primary" reviewId="confirmation/confirm" onClick={onConfirm}>
        Підтвердити демо
      </Action>
    </div>
  );
}
