import { useState } from 'react';
import {
  Accordion,
  Alert,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Checkbox,
  Chip,
  ConfirmDialog,
  DropdownMenu,
  Empty,
  FormField,
  IconButton,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Popover,
  Progress,
  RadioGroup,
  SegmentedControl,
  Select,
  SelectionBar,
  Separator,
  Skeleton,
  Slider,
  Spinner,
  Switch,
  Table,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Tabs,
  Textarea,
  Timeline,
  Tooltip,
  Tree,
  User,
  UI_COLORS,
  UI_SIZES,
  UI_VARIANTS,
  type UiColor,
  type UiSize,
  type UiVariant
} from '../components/ui/index';

/**
 * The inventory, on one page (021, T030).
 *
 * Every component in every variant, size and state it declares. This is where
 * a regression shows up without hunting through fifteen routes, and where the
 * light theme and reduced motion are checked in one place rather than screen by
 * screen.
 *
 * Development only: the route that reaches it is guarded, and a production
 * bundle must not contain this module (T032).
 */

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ds-row">
      <h3 className="ds-row-title">{title}</h3>
      <div className="ds-row-body">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="ds-section">
      <h2 className="ds-section-title">{title}</h2>
      {children}
    </section>
  );
}

export default function DesignSystemPage() {
  const [tab, setTab] = useState<'buttons' | 'forms' | 'data' | 'overlays'>('buttons');
  const [segment, setSegment] = useState<'all' | 'free'>('all');
  const [radio, setRadio] = useState<'optimal' | 'custom'>('optimal');
  const [picto, setPicto] = useState<'fit' | 'fill' | 'blur'>('fit');
  const [checked, setChecked] = useState(true);
  const [switched, setSwitched] = useState(false);
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [menu, setMenu] = useState(false);
  const [popover, setPopover] = useState(false);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['root']));
  const [openPanels, setOpenPanels] = useState<Set<string>>(new Set(['one']));

  return (
    <div className="ds-page">
      <header className="ds-header">
        <h1>Design system</h1>
        <p className="prose">
          Every component the inventory declares, in every variant, size and state. Switch the
          theme and turn on reduced motion; nothing here should become unreadable or start moving
          when it was asked not to.
        </p>
      </header>

      <Tabs
        value={tab}
        onChange={setTab}
        label="Sections"
        items={[
          { id: 'buttons', label: 'Buttons and badges' },
          { id: 'forms', label: 'Forms' },
          { id: 'data', label: 'Data' },
          { id: 'overlays', label: 'Overlays and feedback' }
        ]}
      />

      {tab === 'buttons' && (
        <>
          <Section title="Button — variant × colour">
            {UI_VARIANTS.map(variant => (
              <Row key={variant} title={variant}>
                {UI_COLORS.map(color => (
                  <Button key={color} color={color as UiColor} variant={variant as UiVariant}>
                    {color}
                  </Button>
                ))}
              </Row>
            ))}
          </Section>

          <Section title="Button — size and state">
            <Row title="sizes">
              {UI_SIZES.map(size => (
                <Button key={size} color="primary" size={size as UiSize}>
                  {size}
                </Button>
              ))}
            </Row>
            <Row title="states">
              <Button color="primary">rest</Button>
              <Button color="primary" loading>
                loading
              </Button>
              <Button color="primary" disabled>
                disabled
              </Button>
              <Button color="error" variant="soft">
                destructive
              </Button>
              <Button color="primary" block>
                block
              </Button>
            </Row>
            <Row title="icon buttons">
              {UI_SIZES.slice(0, 4).map(size => (
                <IconButton key={size} label={`Icon ${size}`} size={size as UiSize}>
                  <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
                    <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.75" fill="none" />
                  </svg>
                </IconButton>
              ))}
              <IconButton label="Pressed" pressed>
                <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
                  <circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.75" fill="none" />
                </svg>
              </IconButton>
            </Row>
          </Section>

          <Section title="Badge and Chip">
            <Row title="badges">
              {UI_COLORS.map(color => (
                <Badge key={color} color={color as UiColor}>
                  {color}
                </Badge>
              ))}
            </Row>
            <Row title="chips">
              <Chip>plain</Chip>
              <Chip selected>selected</Chip>
              <Chip color="info" onRemove={() => {}} removeLabel="Remove tag">
                removable
              </Chip>
              <Chip disabled>disabled</Chip>
            </Row>
          </Section>

          <Section title="Card">
            <Row title="roles">
              <Card role="surface" title="Surface" description="A plain container on the page.">
                <p className="prose">Content.</p>
              </Card>
              <Card role="panel" title="Panel" aside="720p · 30 FPS" description="A group of controls.">
                <p className="prose">Content.</p>
              </Card>
              <Card role="section" title="Section" description="A titled block inside a dialog.">
                <p className="prose">Content.</p>
              </Card>
            </Row>
          </Section>

          <Section title="Alert">
            <Row title="colours">
              {(['info', 'success', 'warning', 'error', 'neutral'] as const).map(color => (
                <Alert key={color} color={color} title={color}>
                  What is true, in one sentence.
                </Alert>
              ))}
            </Row>
          </Section>
        </>
      )}

      {tab === 'forms' && (
        <Section title="Form controls">
          <Row title="input">
            <FormField label="Name" help="One line of help.">
              <Input placeholder="Placeholder" />
            </FormField>
            <FormField label="Invalid" error="This value is not valid.">
              <Input defaultValue="wrong" invalid />
            </FormField>
            <FormField label="With a unit">
              <Input width="narrow" defaultValue="1000" suffix="мс" />
            </FormField>
            <FormField label="Number with steppers">
              <InputNumber steppers defaultValue={50} stepUpLabel="More" stepDownLabel="Less" />
            </FormField>
          </Row>
          <Row title="select and textarea">
            <FormField label="Select">
              <Select
                placeholder="Any"
                options={[
                  { value: 'a', label: 'First' },
                  { value: 'b', label: 'Second' }
                ]}
              />
            </FormField>
            <FormField label="Textarea">
              <Textarea placeholder="Longer text" />
            </FormField>
          </Row>
          <Row title="choice">
            <Checkbox label="Checkbox" checked={checked} onChange={() => setChecked(!checked)} />
            <Checkbox label="Indeterminate" indeterminate readOnly checked={false} />
            <Checkbox label="Disabled" disabled />
            <Switch label="Switch" checked={switched} onChange={() => setSwitched(!switched)} />
            <SegmentedControl
              label="Scope"
              value={segment}
              onChange={setSegment}
              options={[
                { value: 'all', label: 'All' },
                { value: 'free', label: 'Free' }
              ]}
            />
          </Row>
          <Row title="radio group">
            <RadioGroup
              label="Mode"
              value={radio}
              onChange={setRadio}
              options={[
                { value: 'optimal', label: 'Optimal', description: '30 FPS · CRF 26 · 720p' },
                { value: 'custom', label: 'Custom', description: 'Set each value yourself' }
              ]}
            />
            <RadioGroup
              label="Fit"
              variant="pictos"
              value={picto}
              onChange={setPicto}
              summary="Fit — the whole frame"
              options={[
                { value: 'fit', label: 'Fit', short: 'Fit' },
                { value: 'fill', label: 'Fill', short: 'Fill' },
                { value: 'blur', label: 'Blur', short: 'Blur' }
              ]}
            />
          </Row>
          <Row title="slider">
            <Slider min={0} max={100} defaultValue={40} aria-label="Quality" />
          </Row>
        </Section>
      )}

      {tab === 'data' && (
        <Section title="Data surfaces">
          <Row title="table">
            <Table columns="minmax(0, 2fr) 1fr 1fr auto" label="Example" size="sm">
              <TableHeader>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Size</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableHeader>
              <TableRow interactive>
                <TableCell>creative-01.mp4</TableCell>
                <TableCell>
                  <Badge color="success">Ready</Badge>
                </TableCell>
                <TableCell>12 MB</TableCell>
                <TableCell>
                  <Button size="xs" variant="ghost">
                    Open
                  </Button>
                </TableCell>
              </TableRow>
              <TableRow selected>
                <TableCell>creative-02.mp4</TableCell>
                <TableCell>
                  <Badge color="warning">Pending</Badge>
                </TableCell>
                <TableCell>8 MB</TableCell>
                <TableCell>
                  <Button size="xs" variant="ghost">
                    Open
                  </Button>
                </TableCell>
              </TableRow>
            </Table>
          </Row>
          <Row title="tree">
            <Tree
              label="Folders"
              expandedIds={expanded}
              selectedId="child"
              onSelect={() => {}}
              onToggle={id =>
                setExpanded(current => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              nodes={[
                {
                  id: 'root',
                  label: 'All files',
                  meta: 14,
                  children: [{ id: 'child', label: 'Creatives', meta: 4 }]
                }
              ]}
            />
          </Row>
          <Row title="accordion">
            <Accordion
              openIds={openPanels}
              onToggle={id =>
                setOpenPanels(current => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })
              }
              items={[
                { id: 'one', title: 'First', aside: 'two items', content: <p>Body.</p> },
                { id: 'two', title: 'Second', content: <p>Body.</p> }
              ]}
            />
          </Row>
          <Row title="timeline and user">
            <Timeline
              entries={[
                { id: '1', title: 'Storage connected', meta: '12 Sep, 18:58', tone: 'success' },
                { id: '2', title: 'Full scan requested', meta: '12 Sep, 18:59' }
              ]}
            />
            <User name="Beta Tester" meta="beta@soty.local" />
          </Row>
          <Row title="breadcrumb and pagination">
            <Breadcrumb
              label="Path"
              items={[
                { id: 'root', label: 'All files', onSelect: () => {} },
                { id: 'lands', label: 'Lands', onSelect: () => {} },
                { id: 'current', label: 'Current' }
              ]}
            />
            <Pagination
              page={page}
              pageCount={5}
              onChange={setPage}
              label="Pages"
              previousLabel="Back"
              nextLabel="Next"
            />
          </Row>
          <Row title="selection bar">
            <SelectionBar
              count={3}
              label="3 selected"
              clearLabel="Clear selection (3)"
              onClear={() => {}}
              actions={
                <>
                  <Button size="sm" variant="outline">
                    Process
                  </Button>
                  <Button size="sm" variant="soft" color="error">
                    Delete
                  </Button>
                </>
              }
            />
          </Row>
        </Section>
      )}

      {tab === 'overlays' && (
        <Section title="Overlays and feedback">
          <Row title="empty and loading">
            <Empty
              title="Nothing here yet"
              description="One sentence about what is true, and the way out."
              action={<Button color="primary">Add the first one</Button>}
            />
            <Skeleton shape="row" count={3} label="Loading rows" />
            <Skeleton shape="tile" count={2} label="Loading tiles" />
          </Row>
          <Row title="progress">
            <Progress value={35} label="A third done" />
            <Progress label="Working" />
            <Spinner label="Working" />
          </Row>
          <Row title="tooltip">
            <Tooltip label="The first of a group waits; its neighbours do not.">
              <Button variant="outline">Hover me</Button>
            </Tooltip>
          </Row>
          <Row title="overlays">
            <Button onClick={() => setModal(true)}>Open modal</Button>
            <Button color="error" variant="soft" onClick={() => setConfirm(true)}>
              Open confirmation
            </Button>
            <span className="ds-anchor">
              <Button variant="outline" onClick={() => setMenu(true)}>
                Open menu
              </Button>
              <DropdownMenu
                open={menu}
                onClose={() => setMenu(false)}
                label="Example menu"
                items={[
                  { id: 'open', label: 'Open', onSelect: () => {} },
                  { id: 'rename', label: 'Rename', onSelect: () => {} },
                  'separator',
                  { id: 'delete', label: 'Delete', destructive: true, onSelect: () => {} }
                ]}
              />
            </span>
            <span className="ds-anchor">
              <Button variant="outline" onClick={() => setPopover(true)}>
                Open popover
              </Button>
              <Popover open={popover} onClose={() => setPopover(false)} label="Example popover">
                <p className="prose">A surface that grows from its trigger.</p>
              </Popover>
            </span>
          </Row>
          <Separator label="and that is all of it" />
        </Section>
      )}

      {modal && (
        <Modal
          onClose={() => setModal(false)}
          title="A dialog"
          footer={
            <>
              <Button variant="outline" onClick={() => setModal(false)}>
                Cancel
              </Button>
              <Button color="primary" onClick={() => setModal(false)}>
                Confirm
              </Button>
            </>
          }
        >
          <p className="prose">Focus is trapped here and returns to the trigger on close.</p>
        </Modal>
      )}

      {confirm && (
        <ConfirmDialog
          title="Delete this creative?"
          body="It goes to the trash and can be restored for thirty days."
          confirmLabel="Delete the creative"
          cancelLabel="Keep it"
          onCancel={() => setConfirm(false)}
          onConfirm={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
