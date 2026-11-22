import { DISPLAY_FONTS } from '../../../contracts/display-fonts';
import type { DisplayCommand, DisplaySnapshot } from '../../../contracts/display-snapshot';

// Keep these bounds aligned with firmware/focusdesk_device/display_snapshot.h.
export const MAX_SNAPSHOT_BYTES = 4096;
const keys = ['schema_version', 'layout_version', 'revision', 'width', 'height', 'commands'];

function reject(message: string): never { throw new Error(`显示数据未通过设备校验：${message}`); }
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function textFits(text: string, x: number, y: number, fontIndex: number): boolean {
  let cursor = x;
  for (const character of text) {
    const [, width, height, advance, xOffset, yOffset] = DISPLAY_FONTS[fontIndex].glyphs[character.charCodeAt(0) - 32];
    if (width && height && (cursor + xOffset < 0 || y + yOffset < 0 ||
      cursor + xOffset + width > 400 || y + yOffset + height > 300)) return false;
    cursor += advance;
    if (cursor > 400) return false;
  }
  return true;
}

export function parseDisplaySnapshotText(body: string): DisplaySnapshot {
  if (!body.length || new TextEncoder().encode(body).byteLength > MAX_SNAPSHOT_BYTES) reject('内容必须在 4 KiB 以内。');
  // ArduinoJson's is<int>() rejects floating-point tokens, including 400.0.
  // JSON.parse alone would erase this distinction. Ignore numbers inside strings.
  const unquoted = body.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if ((unquoted.match(/-?\d[\d.eE+-]*/g) ?? []).some(token => !/^-?(?:0|[1-9]\d*)$/.test(token))) {
    reject('坐标、尺寸与指令编号必须使用整数。');
  }
  let input: unknown;
  try { input = JSON.parse(body); } catch { reject('响应不是有效 JSON。'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('需要完整的显示快照。');
  const root = input as Record<string, unknown>;
  if (Object.keys(root).length !== keys.length || keys.some(key => !Object.hasOwn(root, key)) ||
    root.schema_version !== 'display-1' || root.layout_version !== 'goal-1') reject('协议或布局版本不受支持。');
  if (root.width !== 400 || root.height !== 300) reject('屏幕尺寸必须是 400 × 300。');
  if (typeof root.revision !== 'string' || !/^[\x21-\x7e]{1,80}$/.test(root.revision)) reject('显示版本无效。');
  if (!Array.isArray(root.commands) || root.commands.length > 64) reject('最多支持 64 条绘图指令。');
  let textLength = 0;
  const commands: DisplayCommand[] = root.commands.map((raw: unknown) => {
    if (!Array.isArray(raw) || raw.length !== 6) reject('绘图指令格式无效。');
    const [kind, x, y, a, b, last] = raw;
    if (!integer(kind, 0, 2) || !integer(x, 0, 399) || !integer(y, 0, 299)) reject('绘图坐标超出屏幕。');
    if (kind === 0) {
      if (!integer(a, 1, 400 - x) || !integer(b, 1, 300 - y) || !integer(last, 0, 3)) reject('矩形尺寸或颜色无效。');
      return [0, x, y, a, b, last];
    }
    if (kind === 1) {
      if (!integer(a, 0, 17) || !integer(b, 0, 3) || typeof last !== 'string' ||
        last.length > 96 || /[^\x20-\x7e]/.test(last)) reject('设备文字仅支持 ASCII、内置字体与四色。');
      if (!textFits(last, x, y, a)) reject('文字字形超出屏幕。');
      textLength += last.length;
      if (textLength > 1024) reject('全部文字超过 1024 字节。');
      return [1, x, y, a, b, last];
    }
    if (!integer(a, 1, 64) || !integer(b, 0, 3) || !integer(last, 0, 1) ||
      x - a < 0 || x + a >= 400 || y - a < 0 || y + a >= 300) reject('菱形尺寸或颜色无效。');
    return [2, x, y, a, b, last];
  });
  return { schema_version: 'display-1', layout_version: 'goal-1', revision: root.revision,
    width: 400, height: 300, commands };
}
