import { useEffect, useRef, useState } from 'react';
import { validReadingDocument, validReadingSection, type ScreenCheckpoint } from '../../contracts/screen-checkpoint';
import './screen-observation.css';

export type ScreenObservationRecord = Omit<ScreenCheckpoint, 'id' | 'readingConfirmed'>;
type Props = {
  tasks: { id: string; title: string }[];
  onSave: (record: ScreenObservationRecord, signal?: AbortSignal) => void | Promise<void>;
};
type Result = Pick<ScreenObservationRecord, 'summary' | 'nextStep' | 'progress' | 'completedParts' | 'readingSection' | 'readingDocument'>;
type Draft = { jpg: string; capturedAt: string; taskId: string | null; result: Result; parts: string; keepPercent: boolean };

function jpeg(source: CanvasImageSource, width: number, height: number): string {
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

async function analyze(image: string, taskId: string | null, signal: AbortSignal): Promise<Result> {
  const res = await fetch('/api/v1/screen-observation', { method: 'POST', signal, redirect: 'error', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, taskId }) });
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
    if (error.name === 'EncodingError') return '图片无法解码，请重新选择 PNG 或 JPEG。';
  }
  return error instanceof Error ? error.message : '本次观察失败，请重试。';
}

export function ScreenObservation({ tasks, onSave }: Props) {
  const [taskId, setTaskId] = useState('');
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const upload = useRef<HTMLInputElement>(null);
  const validTask = tasks.some(item => item.id === taskId) ? taskId : '';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);

  async function readFile(file: File) {
    if (active.current || draft) return;
    const controller = new AbortController();
    active.current = controller;
    const selectedTask = validTask || null;
    const capturedAt = new Date().toISOString();
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const image = await fileJpeg(file);
      controller.signal.throwIfAborted();
      const result = await analyze(image, selectedTask, controller.signal);
      if (!controller.signal.aborted) {
        setDraft({ jpg: image, capturedAt, taskId: selectedTask, result,
          parts: (result.completedParts ?? []).join('\n'), keepPercent: !!result.progress });
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(getError(cause));
    } finally {
      if (active.current === controller) active.current = null;
      if (mounted.current) setWorking(false);
    }
  }

  function change(fields: Partial<Draft>) {
    setDraft(current => current ? { ...current, ...fields } : null);
  }
  function dismiss() {
    setDraft(null); setError('');
  }
  async function confirm() {
    if (!draft || saving || !draft.result.summary.trim()) return;
    const parts = [...new Set(draft.parts.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
    if (parts.length > 8 || parts.some(p => p.length > 64)) { setError('最多填写 8 个已完成部分，每项不超过 64 字符。'); return; }
    setSaving(true); setError('');
    try {
      await onSave({ source: 'manual', capturedAt: draft.capturedAt, taskId: draft.taskId, summary: draft.result.summary.trim(),
        ...(draft.taskId && draft.result.readingSection?.trim() ? {readingSection: draft.result.readingSection.trim(),
          ...(draft.result.readingDocument?.trim() ? {readingDocument: draft.result.readingDocument.trim()} : {})} : {}),
        nextStep: draft.result.nextStep.trim(), progress: draft.keepPercent ? draft.result.progress : null, completedParts: parts });
      if (mounted.current) { dismiss(); setMessage('已保存检查点。'); }
    } catch (cause) {
      if (mounted.current) setError(getError(cause));
    } finally { if (mounted.current) setSaving(false); }
  }

  return <section className="screen-observation" aria-label="手动补记">
    <p>上传已有截图，核对识别出的文字后保存。</p>
    <label className="so-field">关联任务（选填）
      <select value={validTask} disabled={working || !!draft} onChange={event => setTaskId(event.target.value)}>
        <option value="">不关联任务</option>
        {tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select>
    </label>
    <div className="so-actions">
      <button type="button" disabled={working || !!draft} onClick={() => upload.current?.click()}>上传截图</button>
      <input hidden ref={upload} type="file" accept="image/png,image/jpeg" aria-label="选择截图文件"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void readFile(file);
        }} />
    </div>
    {working && <p className="so-note" role="status">正在识别截图…</p>}
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
      {draft.taskId && draft.result.readingSection?.trim() && <label className="so-field">文档标题 <small>用于将同名论文关联到此任务</small>
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
