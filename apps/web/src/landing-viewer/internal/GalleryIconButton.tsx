import type { ComponentProps } from 'react';
import { IconButton } from '../../components/ui';

export function GalleryIconButton({ className = '', ...props }: ComponentProps<typeof IconButton>) {
  return (
    <IconButton
      {...props}
      className={`landing-gallery-delayed-tooltip ${className}`.trim()}
      data-tooltip={props.label}
      title=""
    />
  );
}
