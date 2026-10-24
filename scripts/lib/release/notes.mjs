/** Publish only the frozen version's section, keeping older release details out of its body. */
export function releaseNotesForVersion(markdown, version) {
  const sections = markdown.replace(/\r\n/g, '\n').split(/^# /m).slice(1);
  const matches = sections.filter(section => section.split('\n', 1)[0].trim() === `v${version}`);
  if (matches.length !== 1) throw new Error(`RELEASE_NOTES_INVALID: expected one v${version} section`);
  const body = matches[0].slice(matches[0].indexOf('\n') + 1).trim();
  if (!body || !matches[0].includes('\n')) throw new Error(`RELEASE_NOTES_INVALID: v${version} is empty`);
  return `${body}\n`;
}
