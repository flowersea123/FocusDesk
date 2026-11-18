import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ForegroundFrame } from './ipc.ts';
import type { ArxivPaper } from '../../../contracts/screen-checkpoint.ts';

type Box = { text: string; x: number; y: number; height: number };
const script = fileURLToPath(new URL('./paper-header.js', import.meta.url));
const paperId = '(?:[0-9]{4}\\.[0-9]{4,5}|[a-z][a-z0-9.-]*\\/[0-9]{7})(?:v[1-9][0-9]*)?';
const heading = new RegExp('^\\[(' + paperId + ')\\]\\s+(.+)$', 'i');
const address = new RegExp('^(?:https?://)?(?:www\\.)?arxiv\\.org/(abs|pdf)/(' + paperId + ')(?:\\.pdf)?(?:[?#][^\\s]*)?/?$', 'i');
const translationPanel = /^(?:翻译此页(?:面)?|翻譯這個網頁|翻譯此頁(?:面)?|translate (?:this )?page)\s*[？?]?$/iu;

export function paperFromHeader(title: string, boxes: Box[]): ArxivPaper | undefined {
  // Tab labels and links inside a paper are not proof of the displayed URL. Only
  // accept an entire address in the Chrome address bar region, below the tab strip.
  for (const box of boxes) {
    if (box.y < 24 || box.y > 125 || box.x < 46 || box.x > 335) continue;
    const url = address.exec(box.text.trim().replace(/\s*\/\s*/g, '/'));
    if (!url) continue;
    const id = url[2];
    if (url[1].toLowerCase() === 'abs') {
      const abstract = heading.exec(title.trim());
      return { id, view: 'abstract', ...(abstract?.[1] === id ? { title: abstract[2] } : {}) };
    }
    const paper: ArxivPaper = { id, view: 'pdf' };
    // Chrome places the page number, slash and total on the same row as zoom.
    for (const zoom of boxes.filter(b => b.y > box.y + 9 && b.y < box.y + 135 && /\d+\s*%/.test(b.text))) {
      const line = boxes.filter(b => Math.abs(b.y - zoom.y) <= Math.max(5, zoom.height * .55) && b.x <= zoom.x + 1)
        .sort((a, b) => a.x - b.x).map(b => b.text).join(' ');
      const pair = /(?:^|\s)([1-9]\d{0,4})\s*\/\s*([1-9]\d{0,4})(?=\s|$)/.exec(line);
      if (pair && +pair[1] <= +pair[2]) {
        paper.position = { page: +pair[1], total: +pair[2] };
        break;
      }
    }
    return paper;
  }
}

function recognizeHeader(image: string, signal?: AbortSignal): Promise<Box[] | undefined> {
  return new Promise(resolve => {
    const child = execFile('/usr/bin/osascript', ['-l', 'JavaScript', script], {
      timeout: 3500, killSignal: 'SIGKILL', maxBuffer: 80_000, signal,
    }, (error, stdout) => {
      if (error) return resolve(undefined);
      try {
        const result = JSON.parse(stdout);
        resolve(Array.isArray(result) && result.every(b => b && typeof b.text === 'string' &&
          [b.x, b.y, b.height].every(Number.isFinite)) ? result : undefined);
      } catch { resolve(undefined); }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(Buffer.from(image.slice(image.indexOf(',') + 1), 'base64'));
  });
}

/** Per recorder session, keep only a digest and the recognized metadata. */
export function createPaperReader(recognize = recognizeHeader) {
  let last: { digest: string; pageKey: string; retryAt: number; panel: boolean; paper?: ArxivPaper } | undefined;
  return async function read(frame: ForegroundFrame, signal?: AbortSignal): Promise<ForegroundFrame | null> {
    if (frame.app !== 'Google Chrome' || signal?.aborted) return frame;
    if (translationPanel.test(frame.pageTitle?.trim() ?? '')) return null;
    const digest = createHash('sha256').update(frame.image).digest('hex');
    if (!last || last.digest !== digest || last.pageKey !== frame.pageKey || Date.now() >= last.retryAt) {
      const boxes = await recognize(frame.image, signal);
      signal?.throwIfAborted();
      const paper = boxes ? paperFromHeader(frame.pageTitle ?? '', boxes) : undefined;
      const translationVisible = boxes?.some(box => translationPanel.test(box.text.trim()));
      // A translate bubble beside an unobscured address and PDF toolbar still leaves
      // direct evidence. Drop the bubble when those details cannot be verified.
      const panel = !!translationVisible && !(paper?.view === 'abstract' || paper?.position);
      last = { digest, pageKey: frame.pageKey, panel, paper, retryAt: boxes ? Infinity : Date.now() + 15_000 };
    }
    if (last.panel) return null;
    return last.paper ? { ...frame, paper: last.paper } : frame;
  };
}
