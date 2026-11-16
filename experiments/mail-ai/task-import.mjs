import { createHash } from 'node:crypto';
import { MAX_TASKS, parseDailyOverviewText } from '../../contracts/daily-overview.ts';
import { isDeviceTaskTitle, parseTaskUpdateRequest } from '../../contracts/task-update.ts';
import { localOrigin } from './analyze.mjs';

const action = /阅读|读完|提交|上交|交回|交齐|递交|缴交|递送|上传|交付|填写|填完|填报|完成|报名|注册|回复|交费|缴费|交作业|\b(?:read|submit|send|upload|deliver|complete|finish|file|register|apply|pay|return|reply|respond|hand in|turn in)\b/i;
const deadline = /截止|截至|最迟|最晚|到期|不晚于|\b(?:due|deadline|by|before|no later than)\b/i;
const uncertain = /取消|撤销|作废|过去|原定|原先|原截止|旧日期|已于|已提交|已完成|延期|延长|变更|更改|改为|改至|改期|暂定|可能|如果|若|无需|无须|不用|不必|不再|不要|不需要|不适用|可选|会议|开会|讲座|研讨会|开始时间|并非|是否|或(?:者|是|在|于|可)?|大后天|大约|\b(?:cancel(?:led|ed|lation)?|original(?:ly)?|previous(?:ly)?|instead|extended?|rescheduled?|postponed?|superseded|already|obsolete|tentative|optional|or|if|might|could|may|around|approximately|no longer|not|never|don't|meeting|webinar|seminar)\b/i;
const dateToken = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)|(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日|今天|明天|后天|\b(?:day after tomorrow|today|tomorrow)\b/gi;
const timeToken = /(?<![\d:+-])(\d{1,2}):([0-5]\d)(?![\d:])/g;
const day = 86_400_000, beijing = 8 * 3_600_000;

// The source may contain a second date in a format this small parser does not
// resolve. Never silently choose the first date in that case.
const otherDate = /\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next (?:week|month)|january|february|march|april|june|july|august|september|october|november|december)\b|(?<!\d)\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?(?!\d)|\d+\s*(?:月|日|号)|下周|下个月|星期[一二三四五六日天]|周[一二三四五六日天]|昨天|大后天/i;
const otherClock = /(?:\d[.:]\d|\d\s*(?:点|时|[ap]\.?m\.?)|中午|午夜|\b(?:noon|midnight|morning|evening|afternoon)\b)/i;

// Deliberately accept a date adjacent to its clock time. Date-only, competing
// dates, abbreviations such as CST, and unrecognised zone names need review.
function zoneOffset(sentence) {
  const fixed = /(?:(?:UTC|GMT)\s*)?([+-])(\d{2}):?([0-5]\d)(?!\d)|(?:UTC|GMT)\s*([+-])(\d{1,2})(?![\d:])|(?<=\d)Z\b|\b(?:UTC|GMT|HKT|BJT)\b|北京时间|香港时间|中国标准时间|\b(?:Beijing|China Standard|Hong Kong) time\b|Asia\/(?:Shanghai|Hong_Kong)\b/gi;
  const hits = [...sentence.matchAll(fixed)];
  const rest = sentence.replace(fixed, ' ');
  const unknownZone = /时区|(?:纽约|伦敦|东京|巴黎|美国|日本|当地|太平洋|中部|东部|中央|欧洲|澳洲|澳大利亚|洛杉矶|莫斯科|柏林|澳东|温哥华|韩国|美东|美西)时间|\b(?:[a-z]+ time|[a-z_]+\/[a-z_]+|pst|pdt|est|edt|mst|mdt|cst|cdt|cet|cest|bst|jst|kst|ist|aest|aedt|pacific|eastern|central|pt|mt|ct|et|msk|ast|idt|wib|wit|wita)\b|[+-]\s*\d/iu;
  if (hits.length > 1 || unknownZone.test(rest) || /\b[A-Z]{2,5}T\b/.test(rest)) return null;
  if (!hits.length) return beijing;
  const [name, sign1, hour1, minute, sign2, hour2] = hits[0];
  if (sign1 || sign2) {
    const hours = Number(hour1 ?? hour2), minutes = Number(minute ?? 0);
    if (hours > 14 || (hours === 14 && minutes > 0)) return null;
    return ((sign1 ?? sign2) === '-' ? -1 : 1) * (hours * 60 + minutes) * 60_000;
  }
  return /^(Z|UTC|GMT)$/i.test(name) ? 0 : beijing;
}

function calendarDate(match, receivedTime) {
  const [, y, m, d, zhYear, zhMonth, zhDay] = match;
  if (y || zhYear) {
    const padded = `${y ?? zhYear}-${(m ?? zhMonth).padStart(2, '0')}-${(d ?? zhDay).padStart(2, '0')}`;
    const date = Date.parse(`${padded}T00:00:00Z`);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== padded) return null;
    return date;
  }
  if (!Number.isFinite(receivedTime)) return null;
  const daysAhead = /后天|day after tomorrow/i.test(match[0]) ? 2 : /明天|tomorrow/i.test(match[0]) ? 1 : 0;
  return (Math.floor((receivedTime + beijing) / day) + daysAhead) * day;
}

/** Verbatim mail sentence -> UTC timestamp. Unzoned and relative dates use Beijing time. */
export function deriveDeadline(evidence, receivedAt) {
  if (typeof evidence !== 'string' || evidence.length > 750) return null;
  const sentence = evidence.trim().normalize('NFKC').replace(/[.。!！]$/, '');
  if (!action.test(sentence) || uncertain.test(sentence) || /[\r\n。;!?]|\.\s|^>/.test(sentence)) return null;
  const dates = [...sentence.matchAll(dateToken)], times = [...sentence.matchAll(timeToken)];
  if (dates.length !== 1 || times.length !== 1) return null;
  const date = dates[0], clock = times[0];
  const afterDate = date.index + date[0].length, afterTime = clock.index + clock[0].length;
  if (clock.index < afterDate || !/^\s*(?:T|at|上午|下午|晚上)?\s*$/i.test(sentence.slice(afterDate, clock.index))) return null;
  if (!deadline.test(sentence) && !/^\s*(?:(?:北京|香港)时间\s*)?(?:之|以)?前/.test(sentence.slice(afterTime))) return null;

  // Do not use mail parsing machine's timezone to anchor a relative date.
  const receivedTime = typeof receivedAt === 'string' && /(?:Z|[+-]\d\d:?\d\d)$/i.test(receivedAt) ? Date.parse(receivedAt) : NaN;
  const midnight = calendarDate(date, receivedTime);
  if (midnight === null) return null;
  // Mask the date/time when looking for zone names and numeric offsets. ISO
  // dates themselves contain minus signs. Leave time-attached Z visible.
  const zoneText = sentence.slice(0, date.index) + ' 00' + sentence.slice(afterTime);
  const offset = zoneOffset(zoneText);
  if (offset === null || (!date[1] && !date[4] && offset !== beijing)) return null;

  let hours = Number(clock[1]);
  const between = sentence.slice(afterDate, clock.index);
  const amPm = /^\s*(am|pm)\b/i.exec(sentence.slice(afterTime))?.[1].toLowerCase();
  if (/^\s*[ap]\.m\b/i.test(sentence.slice(afterTime))) return null;
  const morning = /上午/.test(between) || amPm === 'am';
  const afternoon = /下午|晚上/.test(between) || amPm === 'pm';
  if (morning || afternoon) {
    if (hours < 1 || hours > 12 || (morning && afternoon)) return null;
    hours = hours % 12 + (afternoon ? 12 : 0);
  }
  if (hours > 23) return null;
  const remaining = zoneText.replace(/(?:UTC|GMT)?\s*[+-]\d{1,2}(?::?\d{2})?\b/gi, '').replace(/00\s*(?:am|pm)\b/i, '');
  if (otherDate.test(remaining) || otherClock.test(remaining)) return null;
  const instant = midnight + hours * 3_600_000 + Number(clock[2]) * 60_000 - offset;
  if (Number.isFinite(receivedTime) && instant < receivedTime) return null;
  return new Date(instant).toISOString();
}

/** A clear calendar-day deadline can be kept without assigning a clock time. */
export function deriveDeadlineDate(evidence, receivedAt) {
  if (typeof evidence !== 'string' || evidence.length > 750) return null;
  const sentence = evidence.trim().normalize('NFKC').replace(/[.。!！]$/, '');
  if (!action.test(sentence) || uncertain.test(sentence) || /[\r\n。;!?]|\.\s|^>/.test(sentence)) return null;
  const dates = [...sentence.matchAll(dateToken)];
  const received = typeof receivedAt === 'string' && /(?:Z|[+-]\d\d:?\d\d)$/i.test(receivedAt) ? Date.parse(receivedAt) : NaN;
  let match, value;
  if (dates.length === 1) {
    match = dates[0];
    const midnight = calendarDate(match, received);
    if (midnight !== null) value = new Date(midnight).toISOString().slice(0, 10);
  } else if (!dates.length && Number.isFinite(received)) {
    // Anchor only a stated month, or the explicit phrase "this month", to the message date.
    match = /(?:(\d{1,2})\s*月|本月)\s*(\d{1,2})\s*[日号]/.exec(sentence);
    if (match) {
      const base = new Date(received + beijing).toISOString().slice(0, 10);
      value = base.slice(0, 5) + (match[1]?.padStart(2, '0') ?? base.slice(5, 7)) + '-' + match[2].padStart(2, '0');
      if (!validPlanDate(value) || value < base) return null;
    }
  }
  if (!match || !value) return null;
  const rest = sentence.slice(0, match.index) + ' ' + sentence.slice(match.index + match[0].length);
  if (otherDate.test(rest) || otherClock.test(rest) || !deadline.test(sentence) &&
      !/^\s*(?:之|以)?前/.test(sentence.slice(match.index + match[0].length))) return null;
  return value;
}

export function validPlanDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export const sourceTaskId = sourceKey => 'src-' + createHash('sha256').update(sourceKey).digest('base64url');

/** Append through the same serialized, revision-checked write as the Dashboard. */
export async function importTask({ hub, sourceKey, title, dueAt, fetcher = fetch }) {
  const origin = localOrigin(hub);
  if (typeof sourceKey !== 'string' || !sourceKey.trim()) return { status: 'review', reason: '缺少可供去重的来源标识' };
  const id = sourceTaskId(sourceKey);
  if (typeof title !== 'string' || !isDeviceTaskTitle(title)) return { status: 'review', id, reason: '设备标题需为 1–40 个可打印英文字符' };
  if (typeof dueAt !== 'string') return { status: 'review', id, reason: '缺少明确截止时间' };
  const task = { id, title, due_at: dueAt, status: 'todo' };
  try { parseTaskUpdateRequest({ revision: 'validation', tasks: [task] }); }
  catch { return { status: 'review', id, reason: '截止时间格式无效' }; }

  const url = origin + '/api/v1/daily-overview';
  const options = () => ({ redirect: 'error', signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = await fetcher(url, options());
    if (!read.ok) throw new Error(`Hub 读取失败（HTTP ${read.status}）`);
    const overview = parseDailyOverviewText(await read.text());
    const existing = overview.tasks.find(item => item.id === id);
    if (existing) {
      if (existing.due_at && Date.parse(existing.due_at) === Date.parse(dueAt)) return { status: 'existing', id };
      return { status: 'review', id, reason: '已有任务的截止时间不同，保留了当前任务' };
    }
    if (overview.tasks.length >= MAX_TASKS) return { status: 'full', id, reason: `待办列表已达 ${MAX_TASKS} 项` };
    const request = parseTaskUpdateRequest({ revision: overview.revision, tasks: [...overview.tasks, task] });
    const write = await fetcher(url + '/tasks', {
      ...options(), method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    if (write.status === 409) { await write.body?.cancel(); continue; }
    if (!write.ok) throw new Error(`Hub 保存失败（HTTP ${write.status}）`);
    const saved = parseDailyOverviewText(await write.text());
    if (!saved.tasks.some(item => item.id === id && item.due_at === dueAt)) throw new Error('Hub 返回的结果未包含新增任务');
    return { status: 'added', id };
  }
  return { status: 'review', id, reason: '任务列表正在被修改，请重试' };
}
