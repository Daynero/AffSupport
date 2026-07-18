import { useEffect, useState, type MouseEvent } from 'react';

const NAVIGATION_EVENT = 'wishly-navigation';

export function currentRoute() {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function navigateTo(path: string, replace = false) {
  if (path === currentRoute()) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

export function useBrowserRoute() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const update = () => setRoute(currentRoute());
    window.addEventListener('popstate', update);
    window.addEventListener(NAVIGATION_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(NAVIGATION_EVENT, update);
    };
  }, []);
  return route;
}

export function internalLink(event: MouseEvent<HTMLAnchorElement>, path: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  navigateTo(path);
}
