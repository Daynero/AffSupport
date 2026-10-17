import type { LaunchPreview as Preview, LaunchCampaign } from '@video-compressor/shared';
import { useState } from 'react';
import { Accordion } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { campaignCountLabel } from './campaignCountLabel';
export function LaunchPreview({
  value,
  rows = []
}: {
  value: Preview | null;
  rows?: LaunchCampaign[];
}) {
  const { language, t } = useI18n();
  const [open, setOpen] = useState(false);
  const campaigns = value?.campaigns ?? rows;
  return (
    <Accordion
      className="launch-preview-accordion"
      items={[
        {
          id: 'launch-preview',
          title: t('launchesPreview'),
          aside: t('launchesPreviewCount', {
            count: campaigns.length,
            campaigns: campaignCountLabel(language, campaigns.length)
          }),
          content: (
            <div className="launch-preview-content">
              <p>{t('launchesPreviewHelp')}</p>
              <div className="launch-preview-list">
                {campaigns.map(c => (
                  <div key={c.ordinal} className="launch-preview-row">
                    <span>{String(c.ordinal).padStart(2, '0')}</span>
                    <span>${c.budget}</span>
                    <span>
                      #{c.ordinal} ({c.adStart}–{c.adEnd})
                    </span>
                    {c.name && (
                      <p className="launch-preview-name m-0 text-label" title={c.name}>
                        {c.name}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        }
      ]}
      openIds={open ? new Set(['launch-preview']) : new Set<string>()}
      onToggle={id => {
        if (id === 'launch-preview') setOpen(value => !value);
      }}
    />
  );
}
