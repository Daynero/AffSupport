import { useEffect, useState } from 'react';

export function initials(name: string | null | undefined, email: string | null | undefined) {
  const source = name?.trim() || email?.split('@')[0] || 'W';
  const words = source.split(/\s+/).filter(Boolean);
  return (
    (words.length > 1 ? `${words[0][0]}${words.at(-1)?.[0] ?? ''}` : source.slice(0, 2))
      .toUpperCase()
      .replace(/[^\p{L}\p{N}]/gu, '') || 'W'
  );
}

export function UserAvatar({
  url,
  name,
  email,
  alt,
  size = 'medium'
}: {
  url: string | null | undefined;
  name: string | null | undefined;
  email: string | null | undefined;
  alt: string;
  size?: 'small' | 'medium' | 'large';
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <span className={`user-avatar avatar-${size}`} aria-label={!url || failed ? alt : undefined}>
      {url && !failed ? (
        <img src={url} alt={alt} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <span aria-hidden="true">{initials(name, email)}</span>
      )}
    </span>
  );
}
