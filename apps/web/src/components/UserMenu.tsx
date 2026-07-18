import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { navigateTo } from '../lib/navigation';
import { UserAvatar } from './UserAvatar';

export function UserMenu() {
  const { user, profile, isAdmin, signOut, status } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const display = profile?.display_name || profile?.email || user?.email || '';
  const email = profile?.email || user?.email || '';

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    requestAnimationFrame(() =>
      menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    );
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);

  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % items.length
            : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const go = (path: string) => {
    setOpen(false);
    navigateTo(path);
  };

  return (
    <div className="user-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="user-menu-trigger"
        aria-label={t('userMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <UserAvatar
          url={profile?.avatar_url}
          name={profile?.display_name}
          email={email}
          alt={t('avatarAlt')}
          size="small"
        />
        <span className="user-menu-trigger-name">{display}</span>
        <span className="user-menu-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open && (
        <div className="user-menu-popover" role="menu" ref={menu} onKeyDown={menuKeyDown}>
          <div className="user-menu-identity">
            <strong>{profile?.display_name || email}</strong>
            {profile?.display_name && <span>{email}</span>}
          </div>
          <button type="button" role="menuitem" onClick={() => go('/account')}>
            {t('account')}
          </button>
          {isAdmin && (
            <button type="button" role="menuitem" onClick={() => go('/admin')}>
              {t('adminPanel')}
            </button>
          )}
          <span className="user-menu-separator" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            disabled={status === 'signing-out'}
            onClick={() => void signOut()}
          >
            {t('signOut')}
          </button>
        </div>
      )}
    </div>
  );
}
