import { validArxivId, type ArxivPaper, type ScreenCheckpoint } from '../../contracts/screen-checkpoint.ts';

export function paperIdKey(id: string) {
  return id.toLowerCase().replace(/v\d+$/u, '');
}

/** macOS reports an application name, Win32 a process name and X11 a window class. */
export function paperBrowser(app?: string): boolean {
  return /^(?:(?:google[ -])?chrome(?:[ -](?:beta|canary|dev|stable))?|chromium(?:-browser)?|(?:microsoft[ -])?edge|msedge|(?:mozilla[ -])?firefox|safari|brave(?:[ -]browser)?|arc|vivaldi|opera)(?:\.exe)?$/iu.test(app ?? '');
}

/** Recover explicit arXiv identities from older checkpoints and non-macOS window titles. */
export function paperInWindow(app: string | undefined, value?: string): ArxivPaper | undefined {
  if (!value || !paperBrowser(app)) return;
  const label = value.trim().replace(/\s+[-–—|]\s+(?:Google Chrome|Microsoft Edge|Mozilla Firefox|Safari|Chromium)$/iu, '')
    .replace(/\s+[-–—|]\s+(?:arXiv(?:\.org)?|alphaXiv)$/iu, '');
  const bracket = /^\[(?:arxiv:\s*)?([^\]]+)\]\s+(.+)$/iu.exec(label);
  if (bracket && validArxivId(bracket[1])) return {id:bracket[1].toLowerCase(), view:'abstract', title:bracket[2].trim()};
  const address = /^(?:https?:\/\/)?(?:www\.)?arxiv\.org\/(abs|pdf)\/(.+?)(?:\.pdf)?\/?(?:[?#].*)?$/iu.exec(label);
  if (address && validArxivId(address[2])) return {id:address[2].toLowerCase(), view:address[1].toLowerCase() === 'pdf' ? 'pdf' : 'abstract'};
  const filename = /^(?:arxiv:\s*)?(.+?)\.pdf$/iu.exec(label);
  if (filename && validArxivId(filename[1])) return {id:filename[1].toLowerCase(), view:'pdf'};
}

export function recordedPaper(row: ScreenCheckpoint) {
  if (row.source !== 'automatic') return;
  return row.paper ?? paperInWindow(row.appName, row.pageTitle);
}

export function knownPaperTitle(rows: ScreenCheckpoint[], id: string): string | undefined {
  const key = paperIdKey(id);
  for (let i = rows.length - 1; i >= 0; i--) {
    const paper = recordedPaper(rows[i]);
    if (paper?.title && paperIdKey(paper.id) === key) return paper.title;
  }
}
