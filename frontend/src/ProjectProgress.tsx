import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyOverview, Task } from '../../contracts/daily-overview';
import { validSections, type ProgressConfig, type ProjectStatus, type ReadingLocation } from '../../contracts/project-progress';
import { checkpointSourceLabel } from '../../contracts/screen-checkpoint';
import { checkpointRequest, confirmReadingBookmark } from './CheckpointWorkspace';
import type { RecorderControls } from './ForegroundRecord';
import { workspaceClock } from './data/workspace-clock';
import { readingLocation } from './data/reading-location';
import './project-progress.css';

export type ProgressResponse = { config:ProgressConfig; statuses:ProjectStatus[] };
const paper = ['Introduction','Related Work','Method','Results','Discussion'];
type Props = {
  overview: DailyOverview | null;
  selected?: Task;
  manual: boolean;
  onFollow: () => void;
  refreshKey: number;
  recorder: RecorderControls;
  data: ProgressResponse | null;
  onData: (value: ProgressResponse) => void;
  onChange: () => void;
};

export function updateProject(input: {revision:string; taskId:string; action:string; sections?:string[]; section?:string; done?:boolean; text?:string}) {
  return checkpointRequest<ProgressResponse>('/api/v1/project-progress', {
    method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(input),
  });
}

export default function ProjectProgress({ overview, selected, manual, onFollow, refreshKey, recorder, data, onData, onChange }: Props) {
  const [draft,setDraft]=useState<{id:string; revision:string; text:string}|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const requests=useRef(0);
  const tasks = overview?.tasks ?? [];
  const target = tasks.find(task => task.id === recorder.status?.targetTaskId);
  const active = recorder.status?.state === 'recording' && recorder.status.mode !== 'ai' && !recorder.readError;
  const current = selected?.id ?? '';
  const canTarget = active && selected?.status === 'todo' && target?.id !== current &&
    (manual || !recorder.status?.observedAt || recorder.status.observedTaskId !== current);
  const timezone = overview?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const status=data?.statuses.find(p=>p.taskId===current);
  const currentPlan = data?.config.plans.find(p => p.taskId === current);
  const plan = currentPlan?.sections ?? [];
  const accept=useCallback((value:ProgressResponse)=>{
    if (!Array.isArray(value.statuses) || !value.config || !Array.isArray(value.config.plans)) throw new Error('本机 Hub 的进度接口不可用。');
    onData(value);
  },[onData]);
  const load=useCallback(async()=>{
    const request=++requests.current;
    try {const value=await checkpointRequest<ProgressResponse>('/api/v1/project-progress');
      if(request===requests.current){accept(value);setError('');}}
    catch(e){if(request===requests.current)setError((e as Error).message);}
  },[accept]);
  useEffect(()=>{void load(); window.addEventListener('focus',load); return ()=>{requests.current++;window.removeEventListener('focus',load);};},[load,overview?.revision,refreshKey]);

  async function change(action:'plan'|'pin'|'unpin'|'set-step', step?:{section:string; done:boolean}) {
    if(!data||!current||busy)return;
    const sections=draft?.text.split('\n').map(s=>s.trim()).filter(Boolean) ?? [];
    if(action==='plan' && !validSections(sections)){setError('请检查重复或过长的步骤。中文自定义步骤可写为“中文 | English”。');return;}
    setBusy(true);setError('');
    try {const updated = await updateProject({revision:action === 'plan' && draft ? draft.revision : data.config.revision,
        taskId:current, action, ...step, ...(action === 'plan' ? {sections} : {})});
      ++requests.current;accept(updated);if(action==='plan')setDraft(null);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function confirmRead(position: ReadingLocation) {
    if (busy) return;
    setBusy(true); setError('');
    try { await confirmReadingBookmark(position.id, position.section); onChange(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const { title: documentTitle, position, bookmark, pageSection } = readingLocation(status);
  const section = pageSection || bookmark?.current.section;
  const confirm = bookmark?.previous && !bookmark.previous.confirmed ? bookmark.previous :
    bookmark?.current && !bookmark.current.confirmed ? bookmark.current : null;
  const latest = status?.latestObservation;
  const pinned = data?.config.pinned === current && !!current;
  const time = (date: string) => new Date(date).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone,
  });

  if (!tasks.length && !error) return null;

  return <section className="project-progress" id="project-progress" tabIndex={-1} aria-labelledby="project-progress-title">
    <header><h3 id="project-progress-title"><span lang="en">Task Details</span>{selected && <span> · {selected.title}</span>}</h3>
      {manual && <button type="button" className="project-follow" onClick={onFollow}>跟随识别结果</button>}
    </header>
    {(canTarget || (active && target)) && <div className="project-selection">
      {canTarget && <button type="button" disabled={!!recorder.pending}
        onClick={() => void recorder.change('target', current)}>用当前录制核对这项任务</button>}
      {active && target && <div className="project-target"><small>正用「{target.title}」核对截图</small>
        <button type="button" disabled={!!recorder.pending} onClick={() => void recorder.change('target', null)}>恢复自动识别</button></div>}
    </div>}
    {!current && tasks.length > 0 && <p>点击上方任务名称可查看任务详情。</p>}
    {current && !status && !error && <p role="status">正在读取任务记录…</p>}
    {status && <>
      {(documentTitle || position || section) && <div className="project-reading">
        <h3 lang="en">Reading Position</h3>
        {position ? <>
          <strong>第 {position.page} / {position.total} 页</strong>
          {section && <p>{pageSection ? '读到 ' : '最近章节书签　'}<strong>{section}</strong></p>}
        </> : section && <div className="project-reading-section">读到 <strong>{section}</strong></div>}
        {documentTitle && <p className="project-document">{documentTitle}</p>}
        {confirm && <button type="button" disabled={busy} onClick={() => void confirmRead(confirm)}>确认已读 {confirm.section}</button>}
      </div>}
      {status.paperVisits && <details className="project-paper-visits">
        <summary>论文访问记录 · {status.paperVisits.documents} 篇</summary>
        <p>{status.paperVisits.date} · {status.paperVisits.count} 次窗口记录{!position && ' · 未记录页码'}</p>
        <ul aria-label="最近访问的论文">{status.paperVisits.recent.map(visit => <li key={visit.title}>
          <time dateTime={visit.at}>{workspaceClock(timezone).format(new Date(visit.at))}</time>
          <span>{visit.title}</span>
        </li>)}</ul>
      </details>}
      {latest && <div className="project-observation"><small>最近截图依据 · <time dateTime={latest.capturedAt}>{time(latest.capturedAt)}</time> · {checkpointSourceLabel(latest.source)}</small>
        <p>{latest.summary}</p></div>}
      {plan.length > 0 && <><p className="project-step-count"><strong lang="en">Checklist</strong>
        <span>{plan.filter(part => status.completed.includes(part)).length} / {plan.length}</span>
      </p><ol className="project-steps" aria-label="完成步骤">{plan.map(part => {
        const done = status.completed.includes(part);
        const next = part === status.remaining[0];
        const edited = currentPlan?.stepEdits?.find(edit => edit.section === part);
        return <li key={part} data-state={done ? 'done' : next ? 'next' : 'later'}>
          <label><input type="checkbox" checked={done} disabled={busy || draft?.id === current}
            onChange={event => void change('set-step', {section:part,done:event.target.checked})}/>{part.split('|')[0].trim()}</label>
          <small>{edited?.done ? '已完成 · 手动勾选' : done ? '已完成 · ' + checkpointSourceLabel(status.automaticParts?.includes(part) ? 'automatic' : 'manual') : next ? '下一步' : '待完成'}</small>
        </li>;
      })}</ol></>}
      <div className="project-actions"><button type="button" disabled={busy} onClick={()=>change(pinned?'unpin':'pin')}>{pinned?'恢复电子屏总览':'在电子屏显示此任务'}</button>
        <button type="button" disabled={busy} onClick={()=>setDraft({id:current,revision:data!.config.revision,text:plan.join('\n')})}>{plan.length?'编辑步骤清单':'定义完成步骤'}</button></div>
      {pinned && <small>已选为电子屏内容 · <a href="/simulator" target="_blank" rel="noreferrer">查看模拟屏 ↗</a></small>}
      {draft?.id===current && <div className="project-plan"><label htmlFor="project-plan-list">完成这个任务需要哪些步骤？</label>
        <p>每行一个步骤，最多 24 个。中文可加设备短名，例如「实验设计 | Experiment design」。</p>
        <textarea id="project-plan-list" rows={5} value={draft.text} onChange={e=>setDraft({...draft,text:e.target.value})}/>
        <div className="project-actions"><button type="button" onClick={()=>setDraft({...draft,text:paper.join('\n')})}>使用论文章节示例</button>
          <button type="button" onClick={()=>change('plan')} disabled={busy}>保存步骤</button><button type="button" onClick={()=>setDraft(null)}>取消</button></div></div>}
    </>}
    {error && <p role="alert">{error} <button type="button" onClick={()=>{setDraft(null);void load();}}>重新载入</button></p>}
  </section>;
}
