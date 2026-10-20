import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { DragDropProvider, useDragDropManager } from '@dnd-kit/react';
import { flushSync } from 'react-dom';
import { useSortable, isSortable } from '@dnd-kit/react/sortable';
import {
  PointerSensor,
  KeyboardSensor,
  Accessibility,
  type Draggable,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent
} from '@dnd-kit/dom';
import { useI18n } from '../../i18n';
import { accountFlowId, emitAccountSignal } from './analytics';
import { accountCenterCollision } from './accountCollision';
import { afterAccountDrop } from './afterAccountDrop';
import { AccountHoldConstraint, AccountHoldProgress, type HoldPoint } from './AccountHoldProgress';

type Kind = 'social' | 'agent';
export interface ReorderRequest {
  flowId?: string;
  kind: Kind;
  parent: string | null;
  moved: string;
  anchor: string;
  relation: 'before' | 'after';
}
interface Item {
  id: string;
  kind: Kind;
  parent: string | null;
  label: string;
  index: number;
}
interface ReorderState {
  socialDragging: boolean;
  preparingSocial: string | null;
  activeParent: string | null;
  suppressClick: () => boolean;
  canMove: (item: Item, direction: -1 | 1) => boolean;
  move: (item: Item, direction: -1 | 1) => void;
}
const Context = createContext<ReorderState | null>(null);
const configurePointerSensor = (present: (point: HoldPoint | null) => void) =>
  PointerSensor.configure({
    // The hidden keyboard activator leaves pointer holding on the
    // entire card. Disabled sorting must not disable its history/finance UI.
    activatorElements: source => [source.element],
    activationConstraints: () => [new AccountHoldConstraint(present)],
    preventActivation(event, source) {
      if (!(event.target instanceof Element)) return true;
      const owner = event.target.closest('[data-reorder-id]');
      if (owner?.getAttribute('data-reorder-id') !== String(source.id)) return true;
      if (event.target.closest('[data-name-color]')) return false;
      return Boolean(
        event.target.closest(
          'button,input,textarea,select,a,[contenteditable="true"],[role="menuitem"]'
        )
      );
    }
  });

function CancelOnChange({
  signature,
  dragging,
  disabled
}: {
  signature: string;
  dragging: boolean;
  disabled: boolean;
}) {
  const manager = useDragDropManager();
  const previous = useRef(signature);
  useEffect(() => {
    if ((disabled || previous.current !== signature) && dragging)
      void manager?.actions.stop({ canceled: true });
    previous.current = signature;
  }, [signature, dragging, disabled, manager]);
  return null;
}
export function AccountReorderProvider({
  children,
  onReorder,
  items,
  signature,
  disabled = false
}: {
  children: ReactNode;
  onReorder: (request: ReorderRequest) => Promise<void>;
  items: Item[];
  signature: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState<Item | null>(null);
  const [holdPoint, setHoldPoint] = useState<HoldPoint | null>(null);
  const [finishingSocial, setFinishingSocial] = useState(false);
  const [preparingSocial, setPreparingSocial] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const suppressUntil = useRef(0);
  const flow = useRef('');
  const start = useRef<Item | null>(null);
  const dropCleanup = useRef<(() => void) | null>(null);
  const preparedCanvas = useRef<{ element: HTMLElement; minimumHeight: string } | null>(null);
  useEffect(() => () => dropCleanup.current?.(), []);
  const viewportAnchor = useRef<{
    table: HTMLElement;
    id: string;
    offset: number;
    left: number;
    canvas: HTMLElement | null;
    minimumHeight: string;
  } | null>(null);
  useLayoutEffect(() => {
    const anchor = viewportAnchor.current;
    if (!anchor) return;
    // Preserve the viewport's physical height, not the expanded content's
    // entire scroll range: otherwise auto-scroll can leave every drop target
    // above a long empty tail. Restore the frozen canvas before unfolding.
    if (anchor.canvas)
      anchor.canvas.style.minHeight = active
        ? `${anchor.table.clientHeight}px`
        : anchor.minimumHeight;
    const headings = [
      ...anchor.table.querySelectorAll<HTMLElement>('.team-account-head[data-reorder-id]')
    ].filter(element => element.dataset.reorderId === anchor.id);
    // Feedback fixes the real source under the pointer. Its library-owned
    // placeholder is the item that moves in flow when the other socials fold.
    // Measuring the fixed source leaves a middle-list viewport on empty canvas.
    const heading =
      headings.find(element => element.closest('[data-dnd-placeholder]')) ?? headings[0];
    if (heading) {
      const captions =
        anchor.table.querySelector('.team-accounts-columns')?.getBoundingClientRect().height ?? 0;
      const offset = active ? anchor.offset : Math.max(anchor.offset, captions);
      anchor.table.scrollTop +=
        heading.getBoundingClientRect().top - anchor.table.getBoundingClientRect().top - offset;
      anchor.table.scrollLeft = anchor.left;
    }
    if (!active) viewportAnchor.current = null;
  }, [active]);
  const latest = useRef(items);
  latest.current = items;
  const latestReorder = useRef(onReorder);
  latestReorder.current = onReorder;
  const prepareSocial = useCallback(
    (source: Draggable | null | undefined) => {
      if (!source || disabled) return;
      const item = latest.current.find(row => row.id === String(source.id));
      if (item?.kind !== 'social') return;
      const list = source.element?.closest<HTMLElement>('.team-accounts-list');
      if (list) {
        if (preparedCanvas.current?.element !== list)
          preparedCanvas.current = { element: list, minimumHeight: list.style.minHeight };
        list.style.minHeight = `${Math.max(
          list.getBoundingClientRect().height,
          Number.parseFloat(list.style.minHeight) || 0
        )}px`;
      }
      flushSync(() => setPreparingSocial(item.id));
    },
    [disabled]
  );
  const sensors = useMemo(
    () => [
      configurePointerSensor(setHoldPoint),
      KeyboardSensor.configure({
        preventActivation: (event, source) => {
          if (
            !(event.target instanceof Element) ||
            !event.target.closest('[data-reorder-keyboard]')
          )
            return true;
          // KeyboardSensor scrolls and centers its source before beforedragstart.
          // Fold first so one arrow advances one compact social, not its old body.
          prepareSocial(source);
          return false;
        }
      })
    ],
    [prepareSocial]
  );
  const accessibility = useMemo(
    () =>
      Accessibility.configure({
        screenReaderInstructions: { draggable: t('accountsMoveInstructions') },
        announcements: {
          dragstart: (event: DragStartEvent) => {
            const item = latest.current.find(row => row.id === String(event.operation.source?.id));
            return item ? t('accountsMoveCaptured', { name: item.label }) : undefined;
          },
          dragover: (event: DragOverEvent) => {
            const source = event.operation.source;
            if (!source || !isSortable(source)) return;
            const item = latest.current.find(row => row.id === String(source.id));
            if (!item) return;
            const total = latest.current.filter(
              row => row.kind === item.kind && row.parent === item.parent
            ).length;
            return t('accountsMovePosition', {
              name: item.label,
              position: source.index + 1,
              total
            });
          },
          dragend: (event: DragEndEvent) => {
            const source = event.operation.source;
            if (event.canceled || !event.operation.target) return t('accountsMoveCancelled');
            if (source && isSortable(source) && source.index === source.initialIndex)
              return t('accountsOrderUnchanged');
            return t('accountsMoveDropped');
          }
        }
      }),
    [t]
  );
  const send = async (request: ReorderRequest) => {
    try {
      await latestReorder.current(request);
      setAnnouncement(t('accountsOrderSaved'));
    } catch {
      setAnnouncement(t('accountsOrderFailed'));
    }
  };
  const value = useMemo<ReorderState>(
    () => ({
      socialDragging: active?.kind === 'social',
      preparingSocial,
      activeParent: active?.kind === 'agent' ? active.parent : null,
      suppressClick: () => Date.now() < suppressUntil.current,
      canMove: (item, direction) => {
        if (disabled) return false;
        const group = latest.current.filter(
          other => other.kind === item.kind && other.parent === item.parent
        );
        const at = group.findIndex(other => other.id === item.id);
        return at >= 0 && Boolean(group[at + direction]);
      },
      move: (item, direction) => {
        if (disabled) return;
        const group = latest.current.filter(
          other => other.kind === item.kind && other.parent === item.parent
        );
        const at = group.findIndex(other => other.id === item.id);
        if (at < 0) return;
        const anchor = group[at + direction];
        if (anchor) {
          const flowId = accountFlowId();
          emitAccountSignal('reorder', 'captured', {
            flowId,
            entity: item.kind === 'agent' ? 'rk' : 'social'
          });
          void send({
            flowId,
            kind: item.kind,
            parent: item.parent,
            moved: item.id,
            anchor: anchor.id,
            relation: direction < 0 ? 'before' : 'after'
          });
        }
      }
    }),
    [active, disabled, preparingSocial]
  );
  return (
    <Context.Provider value={value}>
      <DragDropProvider
        plugins={defaults => [
          ...defaults.filter(plugin => plugin !== Accessibility),
          accessibility
        ]}
        sensors={sensors}
        onBeforeDragStart={event => {
          if (event.defaultPrevented || disabled) return;
          // Measure the complete sortable sibling at header height. The same
          // element must be both sortable and feedback source so dnd-kit moves
          // its placeholder, never a parent containing fixed feedback.
          prepareSocial(event.operation.source);
        }}
        onDragStart={event => {
          const item = latest.current.find(
            candidate => candidate.id === String(event.operation.source?.id)
          );
          if (!item || disabled) return;
          flow.current = accountFlowId();
          start.current = item;
          if (item.kind === 'social') {
            const heading = [
              ...document.querySelectorAll<HTMLElement>('.team-account-head[data-reorder-id]')
            ].find(element => element.dataset.reorderId === item.id);
            const table = heading?.closest<HTMLElement>('.team-accounts-table');
            const canvas = table?.querySelector<HTMLElement>('.team-accounts-list') ?? null;
            if (heading && table)
              viewportAnchor.current = {
                table,
                id: item.id,
                offset: heading.getBoundingClientRect().top - table.getBoundingClientRect().top,
                left: table.scrollLeft,
                canvas,
                minimumHeight:
                  preparedCanvas.current?.element === canvas
                    ? preparedCanvas.current.minimumHeight
                    : (canvas?.style.minHeight ?? '')
              };
          }
          setPreparingSocial(null);
          setFinishingSocial(false);
          dropCleanup.current?.();
          dropCleanup.current = null;
          setActive(item);
          suppressUntil.current = Number.POSITIVE_INFINITY;
          emitAccountSignal('reorder', 'captured', {
            flowId: flow.current,
            entity: item.kind === 'agent' ? 'rk' : 'social'
          });
          setAnnouncement(t('accountsMoveCaptured', { name: item.label }));
        }}
        onDragEnd={event => {
          const before = start.current;
          start.current = null;
          setPreparingSocial(null);
          if (before?.kind === 'social') {
            setFinishingSocial(true);
            dropCleanup.current = afterAccountDrop(event.operation.source?.element, () => {
              preparedCanvas.current = null;
              setFinishingSocial(false);
              setActive(null);
            });
          } else setActive(null);
          suppressUntil.current = Date.now() + 350;
          if (!before) return;
          const source = event.operation.source;
          const target = event.operation.target;
          if (event.canceled || !target || !source || !isSortable(source)) {
            emitAccountSignal('reorder', 'terminal', {
              flowId: flow.current,
              outcome: 'cancelled',
              result: 'cancelled'
            });
            return;
          }
          const group = latest.current.filter(
            item => item.kind === before.kind && item.parent === before.parent
          );
          const index = source.index;
          const old = group.findIndex(item => item.id === before.id);
          const anchor = group[index];
          if (index === old || !anchor || anchor.id === before.id) {
            setAnnouncement(t('accountsOrderUnchanged'));
            emitAccountSignal('reorder', 'terminal', {
              flowId: flow.current,
              result: 'noop',
              outcome: 'skipped'
            });
            return;
          }
          void send({
            flowId: flow.current,
            kind: before.kind,
            parent: before.parent,
            moved: before.id,
            anchor: anchor.id,
            relation: index < old ? 'before' : 'after'
          });
        }}
      >
        <CancelOnChange
          signature={signature}
          dragging={(active !== null && !finishingSocial) || preparingSocial !== null}
          disabled={disabled}
        />
        {children}
        {holdPoint && !active && !disabled && <AccountHoldProgress point={holdPoint} />}
        {/* Keep dnd-kit's default Feedback: it lifts the actual source in-place,
            preserving its full content, ancestor styles, measured size and grab
            point, and supplies the sortable placeholder/drop animation. A custom
            overlay replaces that source and loses the row's grid context. */}
        <div className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </div>
      </DragDropProvider>
    </Context.Provider>
  );
}
export function useAccountReorderItem(item: Item, disabled: boolean) {
  const context = useContext(Context);
  const sortable = useSortable({
    id: item.id,
    collisionDetector: accountCenterCollision,
    index: item.index,
    group: item.kind === 'social' ? 'socials' : `agents:${item.parent}`,
    type: item.kind === 'social' ? 'social' : `agents:${item.parent}`,
    accept: item.kind === 'social' ? 'social' : `agents:${item.parent}`,
    disabled: disabled || !context,
    transition: { duration: 220, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
  });
  return {
    ...sortable,
    socialDragging:
      Boolean(context?.socialDragging) ||
      (item.kind === 'social' && context?.preparingSocial === item.id),
    activeParent: context?.activeParent ?? null,
    suppressClick: context?.suppressClick ?? (() => false),
    canMove: (direction: -1 | 1) => !disabled && Boolean(context?.canMove(item, direction)),
    move: (direction: -1 | 1) => {
      if (!disabled) context?.move(item, direction);
    }
  };
}
export function useAccountDragState() {
  return useContext(Context);
}
