/*
 * The tools home (024, US28) — rethought from the daily visit, not the first one.
 *
 * ## What was wrong
 *
 * The page was built as a catalogue for somebody deciding whether to use Soty,
 * and it is opened many times a day by somebody who already does.
 *
 * - Seven honey buttons on one surface. `primary` is "the one action this screen
 *   exists for" (docs/DESIGN.md); seven of them is none of them.
 * - «Готово до роботи», six times. It was never about the tool: it printed the
 *   local app's connection state under every tile, so one fact was said six
 *   times and the only tile it did not apply to — the browser-only 2FA notebook
 *   — said it too.
 * - A paragraph of pitch per tile. Read once, on the first day, then scrolled
 *   past forever; it made every tile 290px tall and pushed half the tools under
 *   the fold on a laptop.
 * - Only the button looked pressable. The card did take the click, but as a
 *   `role="button"` on an `<article>`: no address, so no middle-click, no
 *   "open in new tab", no link preview.
 * - Spaces — the place its users actually live in — was one announcement card
 *   with an «В розробці» chip nothing in the code backs (`teamWorkspace` is not
 *   a protected flag; access is decided by membership). Getting into *your*
 *   space took a click here, a resolver, and sometimes a lobby.
 * - A centred hero title over a page that is not a hero: it sat off the
 *   header's axis (80% against `--shell-width`), so nothing on the screen lined
 *   up with the logo above it.
 *
 * ## What the buyer needs, in the order they need it
 *
 * 1. Into my space in one click — the one I was last in, first.
 * 2. Or straight to a tool — find it by row, not by scanning six cards.
 * 3. Know at a glance whether the local app is running, because five of the six
 *    tools need it — said once, where the eye starts, with the way to fix it.
 *
 * The benchmarks agree on the shape. Raycast and Linear put the thing you were
 * just doing first and make every row one keystroke away. Google Workspace's
 * app tiles are icon + name, links all the way down, and carry no buttons.
 * Frame.io's home leads with your projects and keeps the product's own news out
 * of the way. None of them puts a call-to-action button inside a tile: the tile
 * *is* the action.
 *
 * ## The anatomy, top to bottom
 *
 * - A header row on the content axis: «Інструменти» left, the local app's state
 *   as one Badge right — with «Як запустити» beside it when there is something
 *   to do about it. That replaces six readiness lines.
 * - A panel under it only when the state needs an action nothing else carries
 *   (pair, update, reload, blocked) or when this browser has never met the app
 *   at all — real onboarding. Somebody whose app is merely closed gets the badge
 *   and the link, not an offer to install software they already run (D2).
 * - Spaces: the spaces themselves, remembered one first, each a link to its own
 *   address. Nobody's member yet — one tile that creates the first space; the
 *   empty state carries the action, not a sentence about where it lives.
 * - Tools in three columns named by the errand — video, landing pages, other.
 *   A tile is icon, name, one line of caption, and it is a link. The only thing
 *   a tile ever adds is the reason it will not open right now: «Потрібен
 *   локальний застосунок». Nothing is said while everything is fine.
 *
 * ## What the second pass changed (the owner, 024: "дрібно, і щоразу доводиться
 * читати, куди тицьнути")
 *
 * - Three *rows* of a three-wide grid meant two of them ended in blank cells:
 *   six tools read as a small cluster in a wide dark panel. One column per
 *   group fills the width, and — the point — a tool never moves: the compressor
 *   is the top of the first column on every visit, so the hand learns the page
 *   and the eye stops reading it.
 * - The icon was a 26px outline in a 44px plate, six of them the same violet:
 *   nothing to recognize, so the name had to be read. It is 32px in 52px now,
 *   which is what carries recognition; the name is bold above a quieter caption
 *   rather than the same weight beside it.
 * - The group label was 11px uppercase muted — a whisper announcing a grouping
 *   that then did no work. It is caption-sized and in the text colour.
 * - A single space sat at a third of the width with two empty cells beside it.
 *   The spaces row now fills whatever it is given: one space is a wide way in,
 *   three share the row.
 * - And spaces are no longer offered to people who cannot have one. The
 *   workspace opens in batches (`can_access_team_workspace`; `create_team`
 *   answers a stranger with a refusal), so a new customer's first sight used to
 *   be «Створіть перший простір» — above the tools that work — leading to a
 *   waiting-list gate. Asked here: inside the gate it is the first row and an
 *   offer, outside it is the last row and a fact.
 *
 * There is no primary button on this page, deliberately: a launcher has no
 * single action, and an honest zero reads calmer than a dishonest seven.
 */
import { useEffect, useId, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { ArrowRight, Plus } from 'lucide-react';
import { Onboarding } from './App';
import { useAgent } from './AgentContext';
import { useI18n, type TranslationKey } from './i18n';
import { analytics } from './analytics/service';
import { agentKnown } from './api/pairing-token';
import { teamApi, type TeamContextSnapshot } from './api/team';
import { Badge, Button, Card, Skeleton } from './components/ui/index';
import { ICON_SIZE, ICON_STROKE } from './components/icons';
import FeatureLockDialog from './components/FeatureLockDialog';
import LocalAppDialog from './components/LocalAppDialog';
import { TeamWorkspaceIcon } from './components/tool-icons';
import type { ConnectionState } from './connection';
import { isLocked } from './lib/feature-flags';
import { usePageEntrance } from './lib/navigation';
import {
  catalogueByGroup,
  catalogueTools,
  type AgentWebTool,
  type WebTool,
  type WebToolGroup
} from './lib/tool-registry';
import { spaceReadiness } from './team/lobby/SpaceCard';
import { buildTeamRoute, teamResolverRoute } from './team/routes';
import { readRememberedSpaceId, useTeam } from './team/TeamContext';

/** One row of spaces. More than that is the lobby's job, and the link to it is in the row's heading. */
const HOME_SPACES = 3;

const GROUP_LABEL: Record<WebToolGroup, TranslationKey> = {
  video: 'homeGroupVideo',
  landing: 'homeGroupLanding',
  other: 'homeGroupOther'
};

/** The same words the header's badge uses: one fact must not have two spellings. */
const STATUS_LABEL: Record<ConnectionState, TranslationKey> = {
  checking: 'connectingAgent',
  connecting: 'lookingForAgent',
  connected: 'agentConnected',
  not_installed_or_not_running: 'agentNotRunning',
  pairing_required: 'agentReady',
  agent_update_required: 'agentUpdateRequired',
  web_update_required: 'webUpdateRequired',
  connection_blocked: 'connectionBlocked',
  entitlement_blocked: 'entitlementBlocked',
  disconnected: 'agentDisconnected'
};

/**
 * States whose way out is an action only the inline panel has — pair, update,
 * reload, reopen through the app. The setup dialog offers none of them.
 */
const NEEDS_PANEL: ReadonlySet<ConnectionState> = new Set<ConnectionState>([
  'pairing_required',
  'agent_update_required',
  'web_update_required',
  'connection_blocked',
  'entitlement_blocked'
]);

/** States the setup dialog answers: open the app, or get it. */
const DIALOG_HELPS: ReadonlySet<ConnectionState> = new Set<ConnectionState>([
  'not_installed_or_not_running',
  'disconnected'
]);

/** A click the browser should keep: a new tab, a new window, a download. */
function plainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

function roleKey(role: TeamContextSnapshot['role']): TranslationKey {
  if (role === 'owner') return 'teamRoleOwner';
  if (role === 'admin') return 'teamRoleAdmin';
  if (role === 'editor') return 'teamRoleEditor';
  return 'teamRoleViewer';
}

/**
 * A tile: a Card whose title is a link stretched over the whole of it.
 *
 * The inventory's Card cannot be an anchor, and should not be: a link's name is
 * everything inside it, so an anchor-card is announced as "Video Compressor
 * Make videos smaller on this computer Needs the local app, link". Here the
 * link is the title, its name is the title, and the caption and the note
 * describe it (`aria-describedby`) — while the pointer still gets the whole
 * surface, because the link's `::after` covers the card (home.css).
 */
function Tile({
  href,
  onFollow,
  icon,
  title,
  caption,
  note,
  badge,
  trailing,
  quiet = false
}: {
  /** Absent for a tile that goes nowhere yet — a tool that is only announced. */
  href?: string;
  onFollow?: () => void;
  icon: ReactNode;
  title: string;
  caption?: ReactNode;
  /** Why it will not simply open right now. Muted, and never colour alone. */
  note?: ReactNode;
  badge?: ReactNode;
  trailing?: ReactNode;
  quiet?: boolean;
}) {
  const id = useId();
  const described = [caption ? `${id}-caption` : null, note ? `${id}-note` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <Card
      as="li"
      interactive={Boolean(href)}
      className={quiet ? 'home-tile is-quiet' : 'home-tile'}
    >
      <span className="home-tile-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="home-tile-copy">
        <div className="home-tile-heading">
          <h4 className="home-tile-title">
            {href ? (
              <a
                className="home-tile-link"
                href={href}
                aria-describedby={described || undefined}
                onClick={event => {
                  if (!plainClick(event)) return;
                  event.preventDefault();
                  onFollow?.();
                }}
              >
                {title}
              </a>
            ) : (
              title
            )}
          </h4>
          {badge}
        </div>
        {caption && (
          <p className="home-tile-caption" id={`${id}-caption`}>
            {caption}
          </p>
        )}
        {note && (
          <p className="home-tile-note" id={`${id}-note`}>
            {note}
          </p>
        )}
      </div>
      {trailing && (
        <span className="home-tile-trailing" aria-hidden="true">
          {trailing}
        </span>
      )}
    </Card>
  );
}

export default function HomePage({ navigate }: { navigate: (path: string) => void }) {
  const { t } = useI18n();
  const { connection, connectedOnce, reconnect, toolAvailable } = useAgent();
  const { teams, loading: teamsLoading } = useTeam();
  const entering = usePageEntrance();
  const spacesTitleId = useId();
  const [help, setHelp] = useState(false);
  const [lockedTool, setLockedTool] = useState<WebTool | null>(null);
  const [setupTool, setSetupTool] = useState<AgentWebTool | null>(null);
  const connected = connection === 'connected';

  useEffect(() => {
    document.title = 'Soty — Tools';
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', 'A collection of local Soty tools for working with your files.');
    analytics.track('home_viewed', {});
    for (const tool of catalogueTools) {
      analytics.track('tool_impression', { tool_identifier: tool.analyticsId });
    }
  }, []);

  const openTool = (tool: WebTool) => {
    analytics.track('tool_open_clicked', { tool_identifier: tool.analyticsId });
    // Web-only access gate: a protected, not-yet-unlocked tool shows the
    // developer-pass modal instead of opening.
    if (tool.featureFlag && isLocked(tool.featureFlag)) {
      setLockedTool(tool);
      return;
    }
    // A browser tool has nothing to wait for. Running it through the checks
    // below would offer to install software it never calls, to someone whose
    // only problem is that the local app happens to be closed.
    if (tool.runtime === 'browser') {
      navigate(tool.path);
      return;
    }
    if (connected && toolAvailable(tool.id)) {
      navigate(tool.path);
      return;
    }
    // The tile said why it would not open; pressing it anyway is asking how to
    // fix that, and the answer is given here rather than on an empty tool page.
    analytics.track(connected ? 'tool_blocked_incompatible' : 'blocked_action_attempted', {
      tool_identifier: tool.analyticsId,
      action_identifier: 'open_tool',
      outcome: 'blocked'
    });
    setSetupTool(tool);
  };

  /**
   * Unanswered invitations, counted for the spaces row.
   *
   * Strictly non-blocking: the home screen must render for people with no team
   * access at all, so a failed or forbidden probe simply means no badge rather
   * than an error anywhere (finding I1).
   */
  const [pendingInvitations, setPendingInvitations] = useState(0);
  useEffect(() => {
    let active = true;
    void teamApi
      .listMyInvitations()
      .then(invitations => {
        if (active) {
          setPendingInvitations(
            invitations.filter(invitation => invitation.state === 'pending').length
          );
        }
      })
      .catch(() => {
        if (active) setPendingInvitations(0);
      });
    return () => {
      active = false;
    };
  }, []);

  /*
   * May this person have a space at all? Only asked when they are in none — being in one is the
   * answer. Never blocking and never an error: the home screen renders for somebody with no team
   * access whatsoever, and "not yet" is a perfectly good answer to draw (finding I1).
   */
  const [spacesOpen, setSpacesOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (teamsLoading) return;
    if (teams.length > 0) {
      setSpacesOpen(true);
      return;
    }
    let active = true;
    void teamApi.canAccessTeamWorkspace().then(allowed => {
      if (active) setSpacesOpen(allowed);
    });
    return () => {
      active = false;
    };
  }, [teams.length, teamsLoading]);
  /* Above the tools while it is somewhere to go, below them while it is only news. */
  const spacesFirst = spacesOpen !== false;
  /* Nothing at all until the answer is in: a create tile that turns into a waiting list a moment
     later is worse than a row that arrives a moment late. */
  const spacesKnown = teamsLoading || teams.length > 0 || spacesOpen !== null;

  /* Read once: the provider rewrites the stored id as spaces are entered, and
     a row that reshuffled itself while being looked at would be worse than one
     that is a visit out of date. */
  const rememberedSpaceId = useMemo(() => readRememberedSpaceId(), []);
  const spaces = useMemo(
    () =>
      [...teams]
        // Stable, so everything but the remembered space keeps the server's order.
        .sort(
          (first, second) =>
            Number(second.id === rememberedSpaceId) - Number(first.id === rememberedSpaceId)
        )
        .slice(0, HOME_SPACES),
    [rememberedSpaceId, teams]
  );

  /* The first agent tool stands in for "the local app" when the setup dialog is
     opened from the status line rather than from a tile: the dialog is about
     the application, and only its analytics care which tool asked. */
  const anyAgentTool = catalogueTools.find(
    (tool): tool is AgentWebTool => tool.runtime === 'agent'
  );
  const firstVisit =
    (connection === 'not_installed_or_not_running' || connection === 'connecting') &&
    !connectedOnce &&
    !agentKnown();
  const showPanel = NEEDS_PANEL.has(connection) || firstVisit;
  const offerHowToStart = !showPanel && DIALOG_HELPS.has(connection) && Boolean(anyAgentTool);
  const statusColor = connected
    ? 'success'
    : connection === 'checking' || connection === 'connecting'
      ? 'neutral'
      : 'warning';
  // D2. Someone who has connected before is looking at a dropped connection,
  // not at an installation problem, and the words should say so.
  const statusLabel =
    !connected && connectedOnce && DIALOG_HELPS.has(connection)
      ? t('agentReconnecting')
      : t(STATUS_LABEL[connection]);

  const allSpacesHref = teamResolverRoute({ showAll: true });
  const createSpaceHref = teamResolverRoute({ create: true });

  /*
   * Spaces are the first thing here for somebody who has one, and the last for somebody who
   * cannot have one yet (024). The workspace opens gradually — `can_access_team_workspace`
   * decides — and the home screen used to lead with "create your first space" for everybody,
   * which for a person outside the gate was a button that ended at a waiting list, above the
   * tools that do work. Asked here, the answer decides both the words and the order.
   */
  const spacesSection = (
    <section className="home-section home-section--spaces" aria-labelledby={spacesTitleId}>
      <div className="home-section-head">
        <h3 className="home-section-title" id={spacesTitleId}>
          {t('teamWorkspace')}
        </h3>
        {(teams.length > 0 || pendingInvitations > 0) && (
          <a
            className="home-section-link"
            href={allSpacesHref}
            aria-label={
              pendingInvitations > 0
                ? t('teamWorkspaceWithInvitations', { count: pendingInvitations })
                : undefined
            }
            onClick={event => {
              if (!plainClick(event)) return;
              event.preventDefault();
              navigate(allSpacesHref);
            }}
          >
            {pendingInvitations > 0 && (
              <Badge color="info" variant="soft">
                {t('teamInvitationBadge', { count: pendingInvitations })}
              </Badge>
            )}
            {t('homeAllSpaces')}
            <ArrowRight size={ICON_SIZE - 4} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </a>
        )}
      </div>

      {teamsLoading && teams.length === 0 ? (
        <Skeleton shape="block" label={t('teamWorkspace')} className="home-spaces-loading" />
      ) : spaces.length > 0 ? (
        <ul className="home-grid">
          {spaces.map(space => {
            const readiness = spaceReadiness(space);
            // Only a connected space has somewhere to go; the lobby is
            // where an unfinished one is resumed or waited for.
            const href =
              readiness === 'ready' ? buildTeamRoute({ spaceId: space.id }) : allSpacesHref;
            return (
              <Tile
                key={space.id}
                href={href}
                onFollow={() => navigate(href)}
                icon={<TeamWorkspaceIcon />}
                title={space.name}
                caption={t(roleKey(space.role))}
                note={
                  readiness === 'setup_incomplete'
                    ? t('teamSpaceCardContinueSetup')
                    : readiness === 'preparing'
                      ? t('teamSpaceCardPreparingHint')
                      : undefined
                }
                badge={
                  space.id === rememberedSpaceId && teams.length > 1 ? (
                    <Badge color="secondary" variant="subtle" size="xs">
                      {t('homeSpaceLast')}
                    </Badge>
                  ) : undefined
                }
                trailing={
                  readiness === 'ready' ? (
                    <>
                      {t('teamSpaceCardEnter')}
                      <ArrowRight size={ICON_SIZE - 4} strokeWidth={ICON_STROKE} />
                    </>
                  ) : undefined
                }
              />
            );
          })}
        </ul>
      ) : (
        <ul className="home-grid">
          {/* Outside the gate the tile is the gate, in the gate's own words: the same title, the
              same sentence, and the button it will offer written on it. Not dimmed — it is a
              real way somewhere, only the last row rather than the first. */}
          <Tile
            href={spacesOpen ? createSpaceHref : allSpacesHref}
            onFollow={() => navigate(spacesOpen ? createSpaceHref : allSpacesHref)}
            icon={
              spacesOpen ? (
                <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} />
              ) : (
                <TeamWorkspaceIcon />
              )
            }
            title={t(spacesOpen ? 'teamSpaceEmptyAction' : 'teamWorkspaceGateTitle')}
            caption={t(spacesOpen ? 'teamSpaceEmptyBody' : 'teamWorkspaceGateBody')}
            trailing={
              spacesOpen ? undefined : (
                <>
                  {t('teamWorkspaceWaitlist')}
                  <ArrowRight size={ICON_SIZE - 4} strokeWidth={ICON_STROKE} />
                </>
              )
            }
          />
        </ul>
      )}
    </section>
  );

  return (
    <>
      <main className={entering ? 'home page-enter' : 'home'}>
        {/* A `div`, not a `header`: the shell has the page's one header, and a
            second landmark of the same kind would need a name to be told apart. */}
        <div className="home-head">
          <h2 className="home-title">{t('homeTitle')}</h2>
          {/* Only when there is something to say. The header above already
              carries "connected" on every page; repeating it four lines lower
              put the same green chip on the screen twice. What the header does
              not offer is the way out of "not running", so that is when the
              page speaks. */}
          <div className="home-status" hidden={connection === 'connected'}>
            {/* The live region is the fact alone: a button inside one is read
                out again every time the fact changes. */}
            <Badge
              role="status"
              color={statusColor}
              variant="soft"
              size="md"
              className="home-status-badge"
              leading={<span className="home-status-dot" />}
            >
              {statusLabel}
            </Badge>
            {offerHowToStart && anyAgentTool && (
              <Button
                variant="link"
                size="sm"
                aria-haspopup="dialog"
                onClick={() => setSetupTool(anyAgentTool)}
              >
                {t('homeHowToStart')}
              </Button>
            )}
          </div>
        </div>

        {showPanel && (
          <div className="home-panel">
            <Onboarding
              state={connection}
              help={help}
              setHelp={setHelp}
              connect={reconnect}
              t={t}
            />
          </div>
        )}

        {spacesKnown && spacesFirst && spacesSection}

        {/*
         * One column per errand, side by side (024).
         *
         * Three rows of a three-wide grid left the right half of two of them empty, so six tools
         * read as a small cluster in a large panel — and every visit began by reading captions,
         * because a tool moved whenever the row above it changed length. A column per group fills
         * the width, and every tool keeps the same place for ever: the compressor is the top of
         * the first column, and after a week nobody reads to find it.
         */}
        <div className="home-tools">
          {catalogueByGroup().map(({ group, tools }) => (
            <section className="home-section" key={group} aria-label={t(GROUP_LABEL[group])}>
              <div className="home-section-head">
                <h3 className="home-section-title">{t(GROUP_LABEL[group])}</h3>
              </div>
              <ul className="home-stack">
                {tools.map(tool => {
                  const openable = tool.status !== 'coming-soon';
                  // Asked only of agent tools: a browser tool has no contract to
                  // be compatible with, and `toolAvailable` takes a `SotyToolId`.
                  // Nothing is said while the first check is still in flight —
                  // a note that appears and vanishes on every visit is noise.
                  const note = !openable
                    ? undefined
                    : tool.runtime !== 'agent' || connection === 'checking'
                      ? undefined
                      : !connected
                        ? t('agentRequired')
                        : toolAvailable(tool.id)
                          ? undefined
                          : t('agentUpdateRequired');
                  return (
                    <Tile
                      key={tool.id}
                      href={openable ? tool.path : undefined}
                      onFollow={() => openTool(tool)}
                      icon={<tool.icon />}
                      title={t(tool.labelKey)}
                      caption={t(tool.captionKey)}
                      note={note}
                      quiet={!openable}
                      badge={
                        tool.status === 'coming-soon' ? (
                          <Badge color="neutral" variant="subtle" size="xs">
                            {t('comingSoon')}
                          </Badge>
                        ) : tool.status === 'in-development' ? (
                          <Badge color="warning" variant="soft" size="xs">
                            {t('inDevelopment')}
                          </Badge>
                        ) : tool.status === 'beta' ? (
                          <Badge color="info" variant="soft" size="xs">
                            {t('betaTesting')}
                          </Badge>
                        ) : undefined
                      }
                    />
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
        {spacesKnown && !spacesFirst && spacesSection}
      </main>

      {lockedTool?.featureFlag && (
        <FeatureLockDialog
          feature={lockedTool.featureFlag}
          onClose={() => setLockedTool(null)}
          onUnlocked={() => {
            const tool = lockedTool;
            setLockedTool(null);
            if (tool.runtime === 'browser' || connected) navigate(tool.path);
          }}
        />
      )}
      {setupTool && (
        <LocalAppDialog
          tool={setupTool.id}
          connection={connection}
          onClose={() => setSetupTool(null)}
        />
      )}
    </>
  );
}
