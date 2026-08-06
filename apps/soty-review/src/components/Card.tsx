import type { KeyboardEvent, ReactNode } from 'react';

export function Card({
  title,
  description,
  reviewId,
  onOpen,
  children
}: {
  title: string;
  description: string;
  reviewId: string;
  onOpen?: () => void;
  children?: ReactNode;
}) {
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onOpen || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    onOpen();
  };
  return (
    <div
      className={`soty-card ${onOpen ? 'is-interactive' : ''}`}
      role={onOpen ? 'link' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      data-review-id={reviewId}
      data-demo-action={onOpen ? '' : undefined}
      onClick={onOpen}
      onKeyDown={keyDown}
    >
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  );
}
