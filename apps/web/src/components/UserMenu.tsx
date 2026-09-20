import { useRef, useState } from 'react';
import {
  ChevronDown,
  CircleUserRound,
  LayoutGrid,
  LifeBuoy,
  LogOut,
  ShieldCheck,
  type LucideIcon
} from 'lucide-react';
import { Button, DropdownMenu, type MenuEntry } from './ui/index';
import { ICON_SIZE, ICON_STROKE } from './icons';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { navigateTo, useBrowserRoute } from '../lib/navigation';
import { analytics } from '../analytics/service';
import { SupportDialog } from './SupportDialog';
import { UserAvatar } from './UserAvatar';

/**
 * The account menu (024, US27).
 *
 * What was wrong. The menu was a hand-rolled dropdown: a column of six bare
 * text rows, no icons, no grouping, nothing to say which of them was the place
 * the reader was already standing in, and a separator only before "Sign out".
 * It looked like a 2015 dropdown because it was built like one — its own
 * arrow-key walk, its own focus dance — while every other menu in the product
 * had already moved to the inventory's `DropdownMenu`.
 *
 * What a buyer wants from this corner, in the order they want it: get to
 * their space; manage the account; find help; sign out. That order is the
 * menu. Language and theme stay in the bar, which keeps them at every width —
 * offering them here too made the menu twice as long to say nothing new.
 *
 * What changed and why.
 * - It is the inventory `DropdownMenu` — the space's menu in the workspace
 *   header is the same component with the same sections, so the product has
 *   one menu, not two. Keyboard walk, typeahead, Escape and focus return come
 *   with it instead of being maintained here.
 * - The identity is the first section's header: avatar, name, e-mail. It is
 *   read, not pressed, and the e-mail is muted and truncated because it is the
 *   one line here that can be forty characters long.
 * - Places, then help, then the way out. Each row carries an icon, and the
 *   place the reader is on says "You are here" — the thing the old menu never
 *   said.
 * - Sign out is last, on its own, in the error colour — the destructive item
 *   is quieter than its neighbours and never next to them.
 * - The trigger is the inventory `Button`: avatar, name and a chevron in
 *   a pill at the small control height, so it stands on the same baseline as
 *   the chips beside it. Under 720px only the avatar remains.
 */
export function UserMenu() {
  const { user, profile, isAdmin, signOut, status } = useAuth();
  const { t } = useI18n();
  const route = useBrowserRoute();
  const [open, setOpen] = useState(false);
  const [technicalSupportOpen, setTechnicalSupportOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const email = profile?.email || user?.email || '';
  const fullName = profile?.display_name || '';
  // The whole name, cut by the stylesheet when it is long: a first name alone
  // turned "Beta Tester" into "Beta", which is nobody.
  const shortName = fullName || email.split('@')[0] || '';
  const here = (path: string) =>
    route === path || route.startsWith(`${path}/`) || route.startsWith(`${path}?`);
  const hereMark = <span className="user-menu-here">{t('userMenuHere')}</span>;

  const openTechnicalSupport = () => {
    setTechnicalSupportOpen(true);
    analytics.track('support_opened', { source_kind: 'technical_support' });
  };

  const icon = (Icon: LucideIcon) => (
    <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
  );

  const items: MenuEntry[] = [
    /* The reader, as a section header: a React Aria collection is built from
       items, sections and headers, so the identity rides as the first
       section's header rather than as a stray element the menu would reject. */
    {
      heading: (
        <span className="user-menu-identity">
          <UserAvatar
            url={profile?.avatar_url}
            name={fullName}
            email={email}
            alt={t('avatarAlt')}
            size="medium"
          />
          <span className="user-menu-identity-copy">
            <strong>{fullName || email}</strong>
            {fullName && <span>{email}</span>}
          </span>
        </span>
      )
    },
    {
      id: 'spaces',
      label: t('teamWorkspace'),
      icon: icon(LayoutGrid),
      trailing: here('/team') ? hereMark : undefined,
      onSelect: () => navigateTo('/team')
    },
    {
      id: 'account',
      label: t('account'),
      icon: icon(CircleUserRound),
      trailing: here('/account') ? hereMark : undefined,
      onSelect: () => navigateTo('/account')
    },
    'separator',
    {
      id: 'support',
      label: t('technicalSupport'),
      icon: icon(LifeBuoy),
      onSelect: openTechnicalSupport
    },
    ...(isAdmin
      ? [
          {
            id: 'admin',
            label: t('adminPanel'),
            icon: icon(ShieldCheck),
            trailing: here('/admin') ? hereMark : undefined,
            onSelect: () => navigateTo('/admin')
          } satisfies MenuEntry
        ]
      : []),
    'separator',
    {
      id: 'sign-out',
      label: t('signOut'),
      icon: icon(LogOut),
      destructive: true,
      disabled: status === 'signing-out',
      onSelect: () => void signOut()
    }
  ];

  return (
    <div className="user-menu">
      <Button
        ref={trigger}
        variant="ghost"
        size="sm"
        className="user-menu-trigger"
        aria-label={t('userMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
        leading={
          <UserAvatar
            url={profile?.avatar_url}
            name={fullName}
            email={email}
            alt={t('avatarAlt')}
            size="small"
          />
        }
        trailing={<ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />}
        onClick={() => setOpen(true)}
      >
        {shortName}
      </Button>
      <DropdownMenu
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        placement="bottom-end"
        minWidth={264}
        label={t('userMenu')}
        className="user-menu-panel"
        items={items}
      />
      {technicalSupportOpen && (
        <SupportDialog
          mode="technical"
          onClose={() => setTechnicalSupportOpen(false)}
          returnFocus={trigger.current}
        />
      )}
    </div>
  );
}
