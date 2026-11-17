/** The workspace uses one timezone at a time. Keep only the most recent formatter for each display style. */
const clocks: { timezone?: string; format: Intl.DateTimeFormat }[] = [];
export function workspaceClock(timezone?: string, withDate = false): Intl.DateTimeFormat {
  const index = withDate ? 1 : 0;
  const cached = clocks[index];
  if (cached && cached.timezone === timezone) return cached.format;
  const format = new Intl.DateTimeFormat('zh-CN', {
    ...(withDate ? {month:'numeric', day:'numeric'} as const : {}),
    hour:'2-digit', minute:'2-digit', hourCycle:'h23', timeZone:timezone,
  });
  clocks[index] = {timezone, format};
  return format;
}
