import { Action } from './Action';
import { Card } from './Card';
import { Confirmation } from './Confirmation';
import { Disclosure } from './Disclosure';
import { Modal } from './Modal';
import { Progress } from './Progress';
import { Status } from './Controls';
import type { ScreenProps } from '../review/model';

export function ScreenScaffold({
  model,
  referencePrefix,
  dispatch,
  children,
  showDisclosure = true
}: ScreenProps & { showDisclosure?: boolean }) {
  return (
    <main className="soty-screen">
      <header className="soty-screen-heading">
        <p className="soty-eyebrow">{model.eyebrow}</p>
        <h1>{model.title}</h1>
        <p>{model.description}</p>
      </header>
      {model.kind === 'loading' && <Progress value={null} label="Завантаження демонстрації" />}
      {model.kind === 'active' && (
        <Progress value={model.progress ?? 64} label="Демонстраційна робота" />
      )}
      {model.kind === 'error' && (
        <div className="soty-message is-error" role="alert">
          Помилка · Демонстраційний стан, дані в безпеці.
        </div>
      )}
      {model.kind === 'success' && (
        <div className="soty-message is-success" role="status">
          Готово · Це локальний приклад результату.
        </div>
      )}
      {model.kind === 'disabled' && (
        <div className="soty-message" role="status">
          Недоступно · Спочатку завершіть попередній демо-крок.
        </div>
      )}
      {model.kind === 'confirmation' && (
        <Confirmation onConfirm={() => dispatch({ type: 'advance-demo' })} />
      )}
      {model.items && model.items.length > 0 ? (
        <div className="soty-item-grid">
          {model.items.map(item => (
            <Card
              key={item.id}
              title={item.title}
              description={item.detail}
              reviewId={`${referencePrefix}/${item.id}`}
            >
              <Status tone={item.status}>
                {item.status === 'active'
                  ? 'Активно'
                  : item.status === 'ready'
                    ? 'Готово'
                    : 'Статус'}
              </Status>
            </Card>
          ))}
        </div>
      ) : model.kind === 'empty' ? (
        <div className="soty-empty">Порожній стан із чітким наступним кроком.</div>
      ) : null}
      {children}
      {model.kind !== 'loading' && model.kind !== 'disabled' && (
        <div className="soty-actions">
          <Action
            variant="primary"
            reviewId={`${referencePrefix}/primary-action`}
            onClick={() => dispatch({ type: 'advance-demo' })}
          >
            Продовжити
          </Action>
          <Action
            variant="secondary"
            reviewId={`${referencePrefix}/details`}
            onClick={() => dispatch({ type: 'open-overlay', overlay: 'details' })}
          >
            Переглянути деталі
          </Action>
        </div>
      )}
      {showDisclosure && (
        <Disclosure
          open={Boolean(model.advanced)}
          onToggle={() => dispatch({ type: 'toggle-disclosure' })}
        >
          <label>
            Якість прикладу{' '}
            <input aria-label="Якість прикладу" type="range" min="1" max="10" defaultValue="8" />
          </label>
          <p>Поточний вибір: безпечний типовий режим. Наслідок запуску залишається видимим.</p>
        </Disclosure>
      )}
      {model.overlay === 'details' && (
        <Modal title="Демонстраційні деталі" onClose={() => dispatch({ type: 'close-overlay' })}>
          <p>Локальні синтетичні дані без зовнішніх операцій.</p>
        </Modal>
      )}
    </main>
  );
}
