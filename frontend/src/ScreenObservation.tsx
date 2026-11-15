import { useEffect, useRef, useState } from 'react';
import { validReadingDocument, validReadingSection, type ScreenCheckpoint } from '../../contracts/screen-checkpoint';
import { frameAppearance, sameAppearance, type FrameAppearance } from './screen-frame';
import './screen-observation.css';

export type ScreenObservationRecord = Omit<ScreenCheckpoint, 'id' | 'readingConfirmed'>;
type Props = {
  tasks: { id: string; title: string }[];
  onSave: (record: ScreenObservationRecord, signal?: AbortSignal) => void | Promise<void>;
};
type Result = Pick<ScreenObservationRecord, 'summary' | 'nextStep' | 'progress' | 'completedParts' | 'readingSection' | 'readingDocument'>;
type Mode = 'once' | 'periodic' | 'upload';
type SampleIdentity = { summary: string; facts?: string; frame?: string; appearance?: FrameAppearance };
type AutoSample = { record: ScreenObservationRecord; identity: SampleIdentity };
type AutomaticCapture = { last?: SampleIdentity; pending?: AutoSample };
type Session = { mode: Mode; taskId: string | null; automatic?: AutomaticCapture; stream?: MediaStream; video?: HTMLVideoElement;
  timer?: ReturnType<typeof setInterval>; abort: AbortController; busy: boolean };
type Draft = { jpg: string; capturedAt: string; taskId: string | null; result: Result; parts: string; keepPercent: boolean };

function releaseMedia(session: Session) {
  session.stream?.getTracks().forEach(track => track.stop());
  if (session.video) session.video.srcObject = null;
  session.stream = undefined;
}

function jpeg(source: CanvasImageSource, width: number, height: number, measure?: (canvas: HTMLCanvasElement) => void): string {
  if (!width || !height) throw new Error('画面还未就绪，请重试。');
  const scale = Math.min(1, 1440 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法读取图像。');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  measure?.(canvas);
  const data = canvas.toDataURL('image/jpeg', 0.78);
  if (!data.startsWith('data:image/jpeg;base64,')) throw new Error('当前浏览器无法生成 JPEG。');
  return data;
}

async function fileJpeg(file: File) {
  if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 8 * 1024 * 1024) {
    throw new Error('请选择 8 MiB 以内的 PNG 或 JPEG。');
  }
  const image = new Image();
  const url = URL.createObjectURL(file);
  try {
    image.src = url;
    await image.decode();
    return jpeg(image, image.naturalWidth, image.naturalHeight);
  } finally { URL.revokeObjectURL(url); }
}

// An identical encoded frame can skip another inference. Near matches still go through the model.
async function frameHash(image: string) {
  if (!crypto.subtle) return undefined;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(image));
  return new Uint8Array(hash).join(',');
}

const normalized = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

function observableFacts(result: Result) {
  if (!result.progress && !result.completedParts?.length && !result.readingSection) return undefined;
  return JSON.stringify([result.progress?.percent ?? null, normalized(result.progress?.evidence ?? ''),
    normalized(result.readingSection ?? ''), normalized(result.readingDocument ?? ''), (result.completedParts ?? []).map(normalized).sort()]);
}

async function analyze(image: string, taskId: string | null, signal: AbortSignal, automatic: boolean): Promise<Result> {
  const res = await fetch('/api/v1/screen-observation', { method: 'POST', signal, redirect: 'error', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, taskId, ...(automatic ? { automatic: true } : {}) }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || '本机模型未能读取截图。');
  if (typeof data.summary !== 'string' || !data.summary.trim() || typeof data.nextStep !== 'string' ||
      (data.readingSection !== undefined && !validReadingSection(data.readingSection)) ||
      (data.readingDocument !== undefined && (!data.readingSection || !validReadingDocument(data.readingDocument))) ||
      !Array.isArray(data.completedParts) || data.completedParts.length > 8 || data.completedParts.some((part: unknown) => typeof part !== 'string' || !part.trim()) ||
      (data.progress !== null && (!Number.isInteger(data.progress?.percent) || data.progress.percent < 0 || data.progress.percent > 100 ||
        typeof data.progress.evidence !== 'string' || !data.progress.evidence.trim()))) {
    throw new Error('模型结果无法读取。');
  }
  return data;
}

function getError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return '没有获得共享权限。可以重新选择，或上传一张截图。';
    if (error.name === 'NotReadableError') return '浏览器无法读取共享画面，请检查系统屏幕录制权限。';
    if (error.name === 'EncodingError') return '图片无法解码，请重新选择 PNG 或 JPEG。';
  }
  return error instanceof Error ? error.message : '本次观察失败，请重试。';
}

export function ScreenObservation({ tasks, onSave }: Props) {
  const [taskId, setTaskId] = useState('');
  const [automatic, setAutomatic] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const active = useRef<Session | null>(null);
  const editing = useRef(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const upload = useRef<HTMLInputElement>(null);
  const validTask = tasks.some(item => item.id === taskId) ? taskId : '';
  const supportsShare = !!navigator.mediaDevices?.getDisplayMedia;

  // The panel owns the capture tracks. Navigating away, closing the tab or the browser's
  // "stop sharing" action releases them. The app never restores a capture session.
  function dispose() {
    const old = active.current;
    active.current = null;
    if (old) {
      clearInterval(old.timer);
      old.abort.abort();
      releaseMedia(old);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const leave = () => { dispose(); setMode(null); setWorking(false); setAutomatic(false); };
    window.addEventListener('pagehide', leave);
    return () => { mounted.current = false; window.removeEventListener('pagehide', leave); dispose(); };
  }, []);

  function stop(note: string) {
    dispose();
    setMode(null); setWorking(false); setAutomatic(false); setMessage(note);
  }

  function isActive(session: Session) { return active.current === session; }

  function startSession(choice: Mode) {
    const session: Session = { mode: choice, taskId: validTask || null,
      automatic: choice === 'periodic' && automatic && validTask ? {} : undefined, abort: new AbortController(), busy: false };
    active.current = session;
    setMode(choice); setError(''); setMessage('');
    return session;
  }

  async function savePending(auto: AutomaticCapture, session: Session) {
    const sample = auto.pending;
    if (!sample) return;
    await onSave(sample.record, session.abort.signal);
    auto.last = sample.identity;
    auto.pending = undefined;
    if (isActive(session)) { setError(''); setMessage('已自动记录本次工作。'); }
  }

  async function take(session: Session, file?: File) {
    if (!isActive(session) || session.busy || editing.current) return;
    session.busy = true; setWorking(true);
    const version = revision.current;
    try {
      const auto = session.automatic;
      // A lost reply can follow a successful write. Retry the original timestamp and content (and thus its UUID).
      if (auto?.pending) await savePending(auto, session);
      if (!isActive(session)) return;
      const video = session.video;
      let appearance: FrameAppearance | undefined;
      const measure = auto ? (canvas: HTMLCanvasElement) => { appearance = frameAppearance(canvas); } : undefined;
      const image = file ? await fileJpeg(file) : jpeg(video!, video!.videoWidth, video!.videoHeight, measure);
      const capturedAt = new Date().toISOString();
      const frame = auto ? await frameHash(image) : undefined;
      if (!isActive(session) || (frame && frame === auto?.last?.frame)) return;
      if (session.mode === 'once') releaseMedia(session);
      const result = await analyze(image, session.taskId, session.abort.signal, !!auto);
      // A result that arrived after an edit, confirmation or dismissal cannot replace it.
      if (!isActive(session) || editing.current || version !== revision.current) return;
      if (auto) {
        const identity = { summary: normalized(result.summary), facts: observableFacts(result), frame, appearance };
        const last = auto.last;
        // Different wording for the same evidence on an almost identical screen is one observation.
        // Keep the last saved appearance as the reference so gradual edits can accumulate.
        if (last && last.facts === identity.facts && (last.summary === identity.summary ||
            (identity.facts !== undefined && sameAppearance(last.appearance, appearance)))) {
          last.frame = frame; setError(''); return;
        }
        auto.pending = { identity, record: { capturedAt, taskId: session.taskId, source: 'automatic',
          summary: result.summary, nextStep: result.nextStep, progress: result.progress, completedParts: result.completedParts,
          ...(result.readingSection ? { readingSection: result.readingSection } : {}),
          ...(result.readingDocument ? { readingDocument: result.readingDocument } : {}) } };
        await savePending(auto, session);
        return;
      }
      setDraft({ jpg: image, capturedAt, taskId: session.taskId, result, parts: (result.completedParts ?? []).join('\n'), keepPercent: !!result.progress });
      setError(''); setMessage('');
    } catch (cause) {
      if (isActive(session)) setError(getError(cause));
    } finally {
      session.busy = false;
      if (isActive(session)) {
        setWorking(false);
        if (session.mode !== 'periodic') { dispose(); setMode(null); }
      }
    }
  }

  async function share(choice: 'once' | 'periodic') {
    if (active.current || draft || !supportsShare) return;
    const session = startSession(choice);
    setWorking(true);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (!isActive(session)) { stream.getTracks().forEach(track => track.stop()); return; }
      session.stream = stream;
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('所选窗口或屏幕无法共享。');
      track.addEventListener('ended', () => { if (isActive(session)) stop('共享已结束。'); }, { once: true });
      const video = document.createElement('video');
      session.video = video; video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      if (!isActive(session)) return;
      if (choice === 'periodic') session.timer = setInterval(() => { void take(session); }, 60_000);
      await take(session);
    } catch (cause) {
      if (isActive(session)) { setError(getError(cause)); stop(''); }
    }
  }

  function change(fields: Partial<Draft>) {
    editing.current = true; revision.current++; setDirty(true);
    setDraft(current => current ? { ...current, ...fields } : null);
  }
  function dismiss() {
    editing.current = false; revision.current++;
    setDirty(false); setDraft(null); setError('');
  }
  async function confirm() {
    if (!draft || saving || !draft.result.summary.trim()) return;
    const parts = [...new Set(draft.parts.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
    if (parts.length > 8 || parts.some(p => p.length > 64)) { setError('最多填写 8 个已完成部分，每项不超过 64 字符。'); return; }
    editing.current = true; revision.current++; setSaving(true); setError('');
    try {
      await onSave({ source: 'manual', capturedAt: draft.capturedAt, taskId: draft.taskId, summary: draft.result.summary.trim(),
        ...(draft.taskId && draft.result.readingSection?.trim() ? {readingSection: draft.result.readingSection.trim(),
          ...(draft.result.readingDocument?.trim() ? {readingDocument: draft.result.readingDocument.trim()} : {})} : {}),
        nextStep: draft.result.nextStep.trim(), progress: draft.keepPercent ? draft.result.progress : null, completedParts: parts });
      if (mounted.current) { dismiss(); setMessage('已保存检查点。'); }
    } catch (cause) {
      if (mounted.current) { setDirty(true); setError(getError(cause)); }
    } finally { if (mounted.current) setSaving(false); }
  }

  return <section className="screen-observation" aria-label="截图检查点">
    <h3>截图检查点</h3>
    <p>选择一个窗口、屏幕或截图，让本机模型起草文字检查点。截图仅用于本次识别。</p>
    <label className="so-field">关联任务
      <select value={validTask} disabled={!!mode || !!draft} onChange={event => { setTaskId(event.target.value); setAutomatic(false); }}>
        <option value="">不关联任务</option>
        {tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select>
    </label>
    <label className="so-auto"><input type="checkbox" aria-describedby="auto-sampling-description" checked={automatic && !!validTask} disabled={!validTask || !supportsShare || !!mode || !!draft}
      onChange={event => setAutomatic(event.target.checked)} /> 周期采样时自动记录</label>
    <p className="so-note" id="auto-sampling-description">选择任务后可开启，仅对本次共享生效。自动记录由模型直接写入，可在下方核对或删除。任务名与论文标题不同时，请先手动保存一次正文书签。</p>
    <div className="so-actions">
      <button type="button" disabled={!supportsShare || !!mode || !!draft} onClick={() => void share('once')}>截取一次</button>
      <button type="button" disabled={!supportsShare || !!mode || !!draft} onClick={() => void share('periodic')}>每分钟采样</button>
      <button type="button" disabled={!!mode || !!draft} onClick={() => upload.current?.click()}>上传截图</button>
      <input hidden ref={upload} type="file" accept="image/png,image/jpeg" aria-label="选择截图文件"
        onChange={event => { const file = event.target.files?.[0]; event.target.value = '';
          if (file && !active.current && !draft) void take(startSession('upload'), file); }} />
      {mode && <button type="button" className="so-stop" onClick={() => stop('采样已停止。')}>停止{mode === 'periodic' ? '采样' : '本次观察'}</button>}
    </div>
    {!supportsShare && <p className="so-note">当前浏览器无法共享屏幕，可使用「上传截图」。</p>}
    {mode === 'periodic' && <p className="so-live" role="status"><span aria-hidden="true">●</span> {active.current?.automatic ? '周期共享中，每分钟自动记录发生变化的工作。' :
      dirty || saving ? '草稿编辑中，已暂停采样。' : '周期共享已开启，每分钟仅保留最新草稿。'}</p>}
    {working && <p className="so-note" role="status">{mode === 'upload' ? '正在读取截图…' : '正在等待共享画面或本机模型…'}</p>}
    {draft && <div className="so-draft">
      <div className="so-draft-head"><h4>审阅检查点</h4><time dateTime={draft.capturedAt}>{new Date(draft.capturedAt).toLocaleTimeString('zh-CN')}</time></div>
      <details><summary>对照本次截图</summary><img alt="本次截图，请核对模型读出的进度与完成部分" src={draft.jpg} /></details>
      <label className="so-field">工作摘要<textarea value={draft.result.summary} maxLength={500} disabled={saving}
        onChange={event => change({ result: { ...draft.result, summary: event.target.value } })} /></label>
      <label className="so-field">下一步<textarea value={draft.result.nextStep} maxLength={350} disabled={saving}
        onChange={event => change({ result: { ...draft.result, nextStep: event.target.value } })} /></label>
      {draft.taskId && <label className="so-field">阅读书签 <small>当前打开的论文章节，可留空</small>
        <input value={draft.result.readingSection ?? ''} maxLength={64} disabled={saving}
          onChange={event => change({ result: { ...draft.result, readingSection: event.target.value } })} /></label>}
      {draft.taskId && draft.result.readingSection?.trim() && <label className="so-field">文档标题 <small>确认后，自动采样可将同名论文关联到此任务</small>
        <input value={draft.result.readingDocument ?? ''} maxLength={180} disabled={saving}
          onChange={event => change({ result: { ...draft.result, readingDocument: event.target.value } })} /></label>}
      <label className="so-field">已完成的具体部分 <small>每行一项，最多 8 项</small>
        <textarea value={draft.parts} disabled={saving} placeholder="例如 Introduction、Method，分别填写"
          onChange={event => change({ parts: event.target.value })} /></label>
      {draft.result.progress ? <div className="so-progress">
        <label><input type="checkbox" checked={draft.keepPercent} disabled={saving} onChange={event => change({ keepPercent: event.target.checked })} />
          保存画面中可核对的进度 · {draft.result.progress.percent}%</label>
        <p>{draft.result.progress.evidence}</p></div> :
        <p className="so-note">{draft.taskId ? '画面中没有可核对的任务完成比例。' : '关联任务且画面中有明确完成比例时，可记录进度。'}</p>}
      <div className="so-actions"><button className="so-primary" type="button" disabled={saving || !draft.result.summary.trim()} onClick={() => void confirm()}>
        {saving ? '正在保存…' : '确认并保存'}</button>
        <button type="button" disabled={saving} onClick={dismiss}>放弃草稿</button></div>
    </div>}
    {message && <p className="so-note" role="status">{message}</p>}
    {error && <p className="so-error" role="alert">{error}</p>}
  </section>;
}

export default ScreenObservation;
