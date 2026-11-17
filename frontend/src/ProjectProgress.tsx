import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyOverview, Task } from '../../contracts/daily-overview';
import { validSections, type ProgressConfig, type ProjectStatus, type ReadingLocation } from '../../contracts/project-progress';
import { checkpointSourceLabel } from '../../contracts/screen-checkpoint';
import { checkpointRequest, confirmReadingBookmark } from './CheckpointWorkspace';
import type { RecorderControls } from './ForegroundRecord';
import './project-progress.css';

type ProgressResponse = { config:ProgressConfig; statuses:ProjectStatus[] };
const paper = ['Introduction','Related Work','Method','Results','Discussion'];
type Props = {
  overview: DailyOverview | null;
  selected?: Task;
  manual: boolean;
  onFollow: () => void;
  refreshKey: number;
  recorder: RecorderControls;
  onPinned: (status: ProjectStatus | null, revision:string) => void;
  onChange: () => void;
};

export function updateProject(input: {revision:string; taskId:string; action:string; sections?:string[]; section?:string; done?:boolean}) {
  return checkpointRequest<ProgressResponse>('/api/v1/project-progress', {
    method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(input),
  });
}

function ProgressMeter({ name, value, text }: { name: string; value: number; text: string }) {
  return <div className="project-meter" role="progressbar" aria-label={name} aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={value} aria-valuetext={text}><span style={{ width: value + '%' }} /></div>;
}

export default function ProjectProgress({ overview, selected, manual, onFollow, refreshKey, recorder, onPinned, onChange }: Props) {
  const [data,setData]=useState<ProgressResponse|null>(null);
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
    setData(value);onPinned(value.statuses.find(s=>s.taskId===value.config.pinned) ?? null, value.config.revision);
  },[onPinned]);
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
  const bookmark = status?.readingBookmark;
  const position = status?.readingPosition;
  const readingPercent = position ? Math.round(100 * position.page / position.total) : null;
  const section = position?.section || bookmark?.current.section;
  const confirm = bookmark?.previous && !bookmark.previous.confirmed ? bookmark.previous :
    bookmark?.current && !bookmark.current.confirmed ? bookmark.current : null;
  const latest = status?.latestObservation;
  const pinned = data?.config.pinned === current && !!current;
  const time = (date: string) => new Date(date).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: timezone,
  });

  if (!tasks.length && !error) return null;

  return <section className="project-progress" id="project-progress" tabIndex={-1} aria-labelledby="project-progress-title">
    <header><h3 id="project-progress-title">大任务进度{selected && <span> · {selected.title}</span>}</h3>
      {manual && <button type="button" className="project-follow" onClick={onFollow}>跟随识别结果</button>}
    </header>
    {(canTarget || (active && target)) && <div className="project-selection">
      {canTarget && <button type="button" disabled={!!recorder.pending}
        onClick={() => void recorder.change('target', current)}>用当前录制核对这项任务</button>}
      {active && target && <div className="project-target"><small>正用「{target.title}」核对截图</small>
        <button type="button" disabled={!!recorder.pending} onClick={() => void recorder.change('target', null)}>恢复自动识别</button></div>}
    </div>}
    {!current && tasks.length > 0 && <p>点击上方任务名称可查看已有进度。</p>}
    {current && !status && !error && <p role="status">正在读取任务进度…</p>}
    {status && <>
      {(position || section) && <div className="project-reading">
        <h3>阅读位置</h3>
        {position && readingPercent !== null ? <>
          <div className="project-meter-label"><strong>第 {position.page} / {position.total} 页</strong><b>{readingPercent}%</b></div>
          <ProgressMeter name={status.title + '阅读位置'} value={readingPercent} text={`第 ${position.page} 页，共 ${position.total} 页，${readingPercent}%`} />
          {section && <p>{position.section ? '读到 ' : '最近章节书签　'}<strong>{section}</strong></p>}
        </> : <div className="project-reading-section">读到 <strong>{section}</strong></div>}
        {(position?.document || bookmark?.current.document) && <p className="project-document">{position?.document || bookmark?.current.document}</p>}
        {confirm && <button type="button" disabled={busy} onClick={() => void confirmRead(confirm)}>确认已读 {confirm.section}</button>}
      </div>}
      {latest && <div className="project-observation"><small>最近截图依据 · <time dateTime={latest.capturedAt}>{time(latest.capturedAt)}</time> · {checkpointSourceLabel(latest.source)}</small>
        <p>{latest.summary}</p></div>}
      {status.percent !== null && <div className="project-completion">
        <h3>{status.total !== null ? '步骤完成度' : '整体完成度'}</h3>
        <div className="project-meter-label">
          <strong>{status.total !== null ? `${status.completed.length} / ${status.total} 个步骤已完成` : '截图中的完成比例'}</strong>
          <b>{status.percent}%</b>
        </div>
        <ProgressMeter name={status.title + '整体进度'} value={status.percent} text={status.percent + '% 已完成'} />
        {status.evidence && <p>{checkpointSourceLabel(status.evidenceSource)} · {status.evidence}</p>}
      </div>}
      {!position && !section && status.percent === null && !latest && <p>暂无进度记录。识别到页码、章节或明确的完成标记后会自动更新。</p>}
      {plan.length > 0 && <ol className="project-steps" aria-label="完成步骤">{plan.map(part => {
        const done = status.completed.includes(part);
        const next = part === status.remaining[0];
        const edited = currentPlan?.stepEdits?.find(edit => edit.section === part);
        return <li key={part} data-state={done ? 'done' : next ? 'next' : 'later'}>
          <label><input type="checkbox" checked={done} disabled={busy || draft?.id === current}
            onChange={event => void change('set-step', {section:part,done:event.target.checked})}/>{part.split('|')[0].trim()}</label>
          <small>{edited?.done ? '已完成 · 手动勾选' : done ? '已完成 · ' + checkpointSourceLabel(status.automaticParts?.includes(part) ? 'automatic' : 'manual') : next ? '下一步' : '待完成'}</small>
        </li>;
      })}</ol>}
      {!plan.length && status.completed.length > 0 && <><h3>已完成的部分</h3>
        <ul>{status.completed.map(part => <li key={part}><span aria-hidden="true">✓</span> {part.split('|')[0].trim()}
          <small> {checkpointSourceLabel(status.automaticParts?.includes(part) ? 'automatic' : 'manual')}</small></li>)}</ul></>}
      <div className="project-actions"><button type="button" disabled={busy} onClick={()=>change(pinned?'unpin':'pin')}>{pinned?'恢复电子屏总览':'在电子屏显示此任务'}</button>
        <button type="button" disabled={busy} onClick={()=>setDraft({id:current,revision:data!.config.revision,text:plan.join('\n')})}>{plan.length?'编辑步骤清单':'定义完成步骤'}</button></div>
      {pinned && <small>已选为电子屏内容 · <a href="/simulator" target="_blank" rel="noreferrer">查看模拟屏 ↗</a></small>}
      {draft?.id===current && <div className="project-plan"><label htmlFor="project-plan-list">完成这个任务需要哪些步骤？</label>
        <p>每行一个等权步骤，最多 24 个。中文可加设备短名，例如「实验设计 | Experiment design」。留空时采用截图中的明确比例。</p>
        <textarea id="project-plan-list" rows={5} value={draft.text} onChange={e=>setDraft({...draft,text:e.target.value})}/>
        <div className="project-actions"><button type="button" onClick={()=>setDraft({...draft,text:paper.join('\n')})}>使用论文章节示例</button>
          <button type="button" onClick={()=>change('plan')} disabled={busy}>保存步骤</button><button type="button" onClick={()=>setDraft(null)}>取消</button></div></div>}
    </>}
    {error && <p role="alert">{error} <button type="button" onClick={()=>{setDraft(null);void load();}}>重新载入</button></p>}
  </section>;
}
