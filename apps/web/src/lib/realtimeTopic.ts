/**
 * A realtime channel name that belongs to one subscriber.
 *
 * `supabase.channel(name)` hands back the channel already registered under that
 * name. Two components that watch the same thing — the task board and the tag
 * settings both reading a space's tags, two panes watching one operation —
 * asked for the same name, received the first one's channel, already
 * subscribed, and `.on()` threw "cannot add postgres_changes callbacks after
 * subscribe()". The exception escaped an effect and took the whole page down
 * (found on the beta opening Space settings → Tags with Tasks already open).
 *
 * The topic is only a label for this browser's socket multiplexing; the rows
 * each subscriber receives are decided by its filter, not by its name, so a
 * suffix per subscriber changes nothing else.
 */
let next = 0;

export function realtimeTopic(base: string): string {
  next += 1;
  return `${base}#${next}`;
}
