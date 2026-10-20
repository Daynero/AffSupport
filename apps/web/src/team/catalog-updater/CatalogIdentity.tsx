import { useRef, useState } from 'react';
import { ExternalLink, Settings2 } from 'lucide-react';
import { ICON_SIZE, ICON_STROKE } from '../../components/icons';
import { Button, Popover } from '../../components/ui/index';
import { useI18n } from '../../i18n';

/** Full identity is available before a mutation, including keyboard and touch. */
export function CatalogIdentity({
  name,
  parts,
  context,
  sheetUrl,
  onConfigure
}: {
  name: string;
  parts: string[];
  context: string;
  sheetUrl: string;
  onConfigure: () => void;
}) {
  const { t } = useI18n();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="catalog-identity"
        ref={anchor}
        aria-label={name}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(value => !value)}
      >
        <span className="catalog-name-prefix">{parts[0]}</span>
        <span className="catalog-name-suffix">{parts[1]}</span>
      </button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        label={name}
        frequent
        placement="bottom-start"
        className="catalog-identity-popover"
      >
        <div className="catalog-identity-heading">
          <strong>{name}</strong>
          <small>{context}</small>
        </div>
        <div className="catalog-identity-actions">
          <a
            className="catalog-identity-action"
            href={sheetUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span>{t('catalogIconsOpenSheet')}</span>
          </a>
          <Button
            className="catalog-identity-action"
            size="sm"
            variant="ghost"
            onClick={() => {
              setOpen(false);
              onConfigure();
            }}
          >
            <Settings2 size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span>{t('catalogUpdaterConfigure')}</span>
          </Button>
        </div>
      </Popover>
    </>
  );
}
