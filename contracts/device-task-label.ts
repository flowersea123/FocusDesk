import { isDeviceTaskTitle, type Task } from './daily-overview.ts';
import { hanReadings } from './han-readings.ts';

/** The firmware uses printable ASCII. Keep the original task name intact on the Hub. */
export function deviceTaskLabel(task: Pick<Task,'id' | 'title' | 'device_title'>): string {
  if (isDeviceTaskTitle(task.device_title)) return task.device_title;
  if (isDeviceTaskTitle(task.title)) return task.title;

  let words = '';
  for (const char of task.title.normalize('NFKD')) {
    if (/\p{M}/u.test(char)) continue;
    const offset = char.codePointAt(0)! - 0x4e00;
    if (offset >= 0 && offset < 0x5200) {
      const pinyin = hanReadings[Math.floor(offset / 32)].split(' ')[offset % 32];
      words += pinyin === '-' ? ' ' : ' ' + pinyin + ' ';
    } else words += /^[\x20-\x7e]$/.test(char) ? char : ' ';
  }
  const label = words.trim().replace(/\s+/g, ' ').replace(/^[a-z]/, initial => initial.toUpperCase());
  if (/[a-z0-9]/i.test(label)) return label.slice(0,40).trimEnd();
  return ('Task ' + task.id.slice(-12)).slice(0,40);
}
