import { deviceTaskLabel } from './device-task-label.ts';
import { devicePart, type ProjectStatus } from './project-progress.ts';
import type { DailyOverview } from './daily-overview.ts';
import { DISPLAY_FONTS } from './display-fonts.ts';

export const DISPLAY_PALETTE = [[0, 0, 0], [255, 255, 255], [255, 218, 0], [210, 32, 32]] as const;
const FONT = { regular10: 10, bold10: 11, regular11: 12, bold11: 13, regular13: 14, regular16: 15, bold16: 16, bold17: 17 } as const;
export type DisplayCommand = [0, number, number, number, number, number] |
  [1, number, number, number, number, string] | [2, number, number, number, number, number];
export interface DisplaySnapshot {
  schema_version: 'display-1';
  layout_version: 'goal-1';
  revision: string;
  width: 400;
  height: 300;
  commands: DisplayCommand[];
}

// Match GFX's xAdvance and glyph ink bounds, including punctuation overhang.
function textBounds(text: string, font: number) {
  let cursor = 0, left = 0, right = 0;
  for (const char of text) {
    const glyph = DISPLAY_FONTS[font].glyphs[char.charCodeAt(0) - 32];
    left = Math.min(left, cursor + glyph[4]);
    right = Math.max(right, cursor + glyph[4] + glyph[1]);
    cursor += glyph[3];
  }
  return { left, width: right - left };
}
function printable(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '?').trim();
}
function lines(value: string, font: number, width: number, count: number): string[] {
  let rest = printable(value);
  const result: string[] = [];
  while (rest && result.length < count) {
    let end = 1;
    while (end <= rest.length && end <= 96 && textBounds(rest.slice(0, end), font).width <= width) end++;
    end--;
    if (end === rest.length) { result.push(rest); break; }
    if (result.length === count - 1) {
      let last = rest.slice(0, end).trimEnd();
      while (last && (last.length + 3 > 96 || textBounds(`${last}...`, font).width > width)) last = last.slice(0, -1);
      result.push(`${last}...`); break;
    }
    const space = rest.lastIndexOf(' ', end);
    if (space > 0) end = space;
    result.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  return result;
}
function localTime(timestamp: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(timestamp));
}

function recommendationLines(value: string | undefined): string[] {
  const normalized = (value ?? '').trim().replace(/\r\n?/g, '\n')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...');
  const content = /[^\x20-\x7e\n]/.test(normalized)
    ? 'Use English for device suggestions.'
    : normalized || 'No suggestion yet.';
  const wrapped = content.split('\n').flatMap(paragraph => {
    const fitted = lines(paragraph, FONT.regular13, 344, 2);
    return fitted.length ? fitted : [''];
  });
  const visible = wrapped.slice(0, 2);
  if (wrapped.length > 2) {
    let last = visible[1].replace(/\.\.\.$/, '');
    while (last && (last.length + 3 > 96 || textBounds(`${last}...`, FONT.regular13).width > 344)) last = last.slice(0, -1);
    visible[1] = `${last}...`;
  }
  return visible;
}

/** Sole layout engine for both the saved device endpoint and live Hub drafts. */
export function buildDisplaySnapshot(overview: DailyOverview): DisplaySnapshot {
  const commands: DisplayCommand[] = [];
  const rect = (x: number, y: number, w: number, h: number, color: number) => { commands.push([0, x, y, w, h, color]); };
  const text = (value: string, x: number, y: number, font: number = FONT.regular11, color = 0, width = 368) => {
    const fitted = lines(value, font, width, 1)[0] ?? '';
    if (fitted) commands.push([1, x - textBounds(fitted, font).left, y, font, color, fitted]);
  };
  const rightText = (value: string, y: number, font: number = FONT.regular11) => {
    text(value, 384 - textBounds(value, font).width, y, font);
  };
  const pending = overview.tasks.filter(task => task.status === 'todo');
  const focused = overview.focus && overview.tasks.find(task => task.id === overview.focus!.task_id && task.status === 'todo');
  const priority = focused || pending[0];
  const ordered = priority ? [priority, ...pending.filter(task => task.id !== priority.id)] : [];
  const visible = ordered.slice(0, 5);
  const date = new Date(`${overview.date}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(date).toUpperCase();
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date).toUpperCase();

  text('FOCUSDESK', 16, 25, FONT.bold11);
  rightText(`${weekday}, ${month} ${date.getUTCDate()}`, 25);
  text('Tasks', 16, 56, FONT.bold17);
  rightText(`${overview.tasks.filter(task => task.status === 'done').length} / ${overview.tasks.length} DONE`, 56);
  if (focused && overview.focus) text(`FOCUS - UNTIL ${localTime(overview.focus.ends_at, overview.timezone)}`, 16, 73, FONT.regular10);

  visible.forEach((task, index) => {
    const top = 87 + index * 24;
    // Eight straight segments form a ten-pixel rounded checkbox.
    for (const [x, y, width, height] of [[2, 0, 6, 1], [1, 1, 1, 1], [8, 1, 1, 1], [0, 2, 1, 6],
      [9, 2, 1, 6], [1, 8, 1, 1], [8, 8, 1, 1], [2, 9, 6, 1]]) rect(32 + x, top + y, width, height, 0);
    text(deviceTaskLabel(task), 54, 97 + index * 24, index === 0 ? FONT.bold16 : FONT.regular16, 0, 330);
  });
  if (visible.length) rect(16, 84, 2, 16, 3);
  else text(overview.tasks.length ? 'All tasks done' : 'No tasks for today', 16, 97, FONT.regular16);
  if (ordered.length > visible.length) rightText(`+${ordered.length - visible.length} more`, 216);

  // Horizontal bands approximate the browser's six-pixel corner radius.
  for (const [inset, top, height] of [[4, 0, 1], [2, 1, 1], [1, 2, 2], [0, 4, 52], [1, 56, 2], [2, 58, 1], [4, 59, 1]]) {
    rect(16 + inset, 224 + top, 368 - inset * 2, height, 2);
  }
  text('AI RECOMMENDATION', 28, 242, FONT.bold10, 0, 344);
  recommendationLines(overview.ai_suggestion).forEach((line, index) => text(line, 28, 256 + index * 16, FONT.regular13, 0, 344));
  return { schema_version: 'display-1', layout_version: 'goal-1', revision: `goal-1:nun1:${overview.revision}`, width: 400, height: 300, commands };
}

/** Pixel-exact bitmap raster. No browser font substitution or antialiasing. */
export function rasterizeDisplaySnapshot(snapshot: DisplaySnapshot): Uint8Array {
  const pixels = new Uint8Array(snapshot.width * snapshot.height).fill(1);
  const pixel = (x: number, y: number, color: number) => {
    if (x >= 0 && y >= 0 && x < 400 && y < 300) pixels[y * 400 + x] = color;
  };
  for (const op of snapshot.commands) {
    if (op[0] === 0) {
      for (let y = op[2]; y < op[2] + op[4]; y++) for (let x = op[1]; x < op[1] + op[3]; x++) pixel(x, y, op[5]);
    } else if (op[0] === 2) {
      for (let dy = -op[3]; dy <= op[3]; dy++) for (let dx = -op[3]; dx <= op[3]; dx++) {
        const distance = Math.abs(dx) + Math.abs(dy);
        if (op[5] ? distance <= op[3] : distance === op[3]) pixel(op[1] + dx, op[2] + dy, op[4]);
      }
    } else {
      const font = DISPLAY_FONTS[op[3]];
      let cursor = op[1];
      for (const char of op[5]) {
        const [offset, width, height, advance, xOffset, yOffset] = font.glyphs[char.charCodeAt(0) - 32];
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const bit = y * width + x;
          if (font.bitmap[offset + (bit >> 3)] & (0x80 >> (bit & 7))) pixel(cursor + xOffset + x, op[2] + yOffset + y, op[4]);
        }
        cursor += advance;
      }
    }
  }
  return pixels;
}

/** Dedicated large-task view. Uses drawing instructions already understood by the device. */
export function buildProjectDisplay(project: ProjectStatus, revision: string): DisplaySnapshot {
  const commands: DisplayCommand[] = [];
  const rect = (x:number,y:number,w:number,h:number,color:number) => commands.push([0,x,y,w,h,color]);
  const draw = (label:string,x:number,y:number,font:number,width:number) => {
    const fitted = lines(label,font,width,1)[0];
    if (fitted) commands.push([1,x - textBounds(fitted,font).left,y,font,0,fitted]);
  };
  const page = project.readingPosition;
  const section = page ? page.section : project.readingBookmark?.current.section;
  const reading = !!(page || section);
  draw('FOCUSDESK  /  TASK LOG',18,25,FONT.bold11,360);
  draw(deviceTaskLabel({id:project.taskId,title:project.title,device_title:project.deviceTitle}),18,reading ? 48 : 61,FONT.bold17,364);
  if (reading) {
    draw('READING POSITION',18,71,FONT.bold11,137);
    if (page) draw('Page ' + page.page + '/' + page.total,161,71,FONT.regular13,210);
    if (section) {
      const name = devicePart(section,[...project.completed,...project.remaining]);
      draw(name ? 'Section: ' + name : 'Section name on Hub',18,92,FONT.regular13,364);
    } else if (page?.document && page.document !== project.title && /^[\x20-\x7e]+$/.test(page.document)) {
      draw(page.document,18,92,FONT.regular13,364);
    }
  }
  const automatic = new Set(project.automaticParts ?? []);
  const items = project.accomplishments ?? project.completed.map(text => ({
    text, source: automatic.has(text) ? 'automatic' : 'manual',
  }));
  const reminder = project.calendarReminder;
  const visible = items.slice(0, reminder ? 4 : 5);
  const headingY = reading ? 120 : 92;
  draw('COMPLETED',18,headingY,FONT.bold11,364);
  visible.forEach(({text,source},i) => {
    const y = headingY + 28 + i * 23;
    const planItem = project.completed.find(item => item.split('|')[0].trim() === text);
    const name = planItem ? devicePart(planItem) : /^[\x20-\x7e]+$/.test(text) ? text : devicePart(text);
    const label = name ?? deviceTaskLabel({id:String(i+1),title:text});
    draw(String(i + 1) + '.',18,y,FONT.bold11,23);
    draw(label,44,y,FONT.regular13,source === 'automatic' ? 273 : 336);
    if (source === 'automatic') draw('AUTO',329,y,FONT.regular10,52);
  });
  if (!items.length) draw('No completed items recorded',18,headingY+28,FONT.regular13,364);
  if (items.length>visible.length) draw('+'+(items.length-visible.length)+' more on Hub',18,reminder ? 264 : 283,FONT.regular10,364);
  if (reminder) {
    rect(0,272,400,28,2);
    draw('TO DO',18,290,FONT.bold11,44);
    draw(reminder.title,71,290,FONT.regular13,reminder.count > 1 ? 265 : 311);
    if (reminder.count > 1) draw('+' + (reminder.count - 1),352,290,FONT.bold11,31);
  }
  return {schema_version:'display-1',layout_version:'goal-1',revision,width:400,height:300,commands};
}
