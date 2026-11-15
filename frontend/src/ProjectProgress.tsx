import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyOverview } from '../../contracts/daily-overview';
import { validSections, type ProgressConfig, type ProjectStatus, type ReadingLocation } from '../../contracts/project-progress';
import { checkpointSourceLabel } from '../../contracts/screen-checkpoint';
import { checkpointRequest, confirmReadingBookmark } from './CheckpointWorkspace';
import './project-progress.css';

type ProgressResponse = { config:ProgressConfig; statuses:ProjectStatus[] };
const paper = ['Introduction','Related Work','Method','Results','Discussion'];
export default function ProjectProgress({overview,refreshKey,onPinned}:{overview:DailyOverview;refreshKey:number;onPinned:(status:ProjectStatus|null)=>void}) {
  const [data,setData]=useState<ProgressResponse|null>(null);
  const [chosen,choose]=useState('');
  const [draft,setDraft]=useState<{id:string; revision:string; text:string}|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const requests=useRef(0);
  const current=overview.tasks.some(t=>t.id===chosen)?chosen:overview.focus?.task_id ?? overview.tasks.find(t=>t.status==='todo')?.id ?? overview.tasks[0]?.id ?? '';
  const status=data?.statuses.find(p=>p.taskId===current);
  const plan=data?.config.plans.find(p=>p.taskId===current)?.sections ?? [];
  const accept=useCallback((value:ProgressResponse)=>{
    if (!Array.isArray(value.statuses) || !value.config || !Array.isArray(value.config.plans)) throw new Error('本机 Hub 的进度接口不可用。');
    setData(value);onPinned(value.statuses.find(s=>s.taskId===value.config.pinned) ?? null);
  },[onPinned]);
  const load=useCallback(async()=>{
    const request=++requests.current;
    try {const value=await checkpointRequest<ProgressResponse>('/api/v1/project-progress');
      if(request===requests.current){accept(value);setError('');}}
    catch(e){if(request===requests.current)setError((e as Error).message);}
  },[accept]);
  useEffect(()=>{void load(); window.addEventListener('focus',load); return ()=>{requests.current++;window.removeEventListener('focus',load);};},[load,overview.revision,refreshKey]);

  async function change(action:'plan'|'pin'|'unpin') {
    if(!data||!current||busy)return;
    const sections=draft?.text.split('\n').map(s=>s.trim()).filter(Boolean) ?? [];
    if(action==='plan' && !validSections(sections)){setError('请检查重复或过长的步骤。中文自定义步骤可写为“中文 | English”。');return;}
    setBusy(true);setError('');
    try {const updated=await checkpointRequest<ProgressResponse>('/api/v1/project-progress',{method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({revision:action==='plan'?draft?.revision:data.config.revision,taskId:current,action,...(action==='plan'?{sections}:{})})});
      ++requests.current;accept(updated);if(action==='plan')setDraft(null);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function confirmRead(position: ReadingLocation) {
    if (busy) return;
    setBusy(true); setError('');
    try { await confirmReadingBookmark(position.id, position.section); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const bookmark = status?.readingBookmark;
  const pinned=data?.config.pinned===current && !!current;
  return <section className="project-progress" id="project-progress" aria-labelledby="project-progress-title">
    <header><div><h2 id="project-progress-title">大任务进度</h2><p>{status?.total?'按清单中已记录的完成项计算':'从屏幕记录中的明确比例读取进度'}</p></div>
      {current && <select aria-label="查看大任务进度" value={current} onChange={e=>{choose(e.target.value);setDraft(null);setError('');}}>
        {overview.tasks.map(t=><option value={t.id} key={t.id}>{t.title}</option>)}</select>}
    </header>
    {!current && <p>先在今日任务中添加一个想跟踪的大任务。</p>}
    {status && <>
      <div className="project-meter-label"><strong>{status.percent===null?'进度待确认':status.percent+'%'}</strong>
        <span>{status.total!==null?`${status.completed.length} / ${status.total} 个步骤已完成`:status.evidence?`${checkpointSourceLabel(status.evidenceSource)} · ${status.evidence}`:'需有明确的进度依据或步骤清单'}</span></div>
      <div className="project-meter" role="progressbar" aria-label={status.title+'整体进度'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={status.percent??undefined}>
        {status.percent!==null && <span style={{width:status.percent+'%'}}/>}</div>
      <h3>已完成的部分</h3>
      {status.completed.length?<ul>{status.completed.map(part=><li key={part}><span aria-hidden="true">✓</span> {part.split('|')[0].trim()} <small>{checkpointSourceLabel(status.automaticParts?.includes(part) ? 'automatic' : 'manual')}</small></li>)}</ul>:<p>尚无记录表明具体部分已完成。</p>}
      {bookmark && <aside className="reading-bookmark" aria-label="阅读书签">
        <h3>阅读书签</h3>
        {bookmark.current.document && bookmark.current.document !== status.title && <p>{bookmark.current.document}</p>}
        <p>上次读到 <strong>{bookmark.current.section}</strong> · {checkpointSourceLabel(bookmark.current.source)}</p>
        {bookmark.previous && !bookmark.previous.confirmed
          ? <button type="button" disabled={busy} onClick={() => void confirmRead(bookmark.previous!)}>确认已读 {bookmark.previous.section}</button>
          : !bookmark.current.confirmed && <button type="button" disabled={busy} onClick={() => void confirmRead(bookmark.current)}>确认已读 {bookmark.current.section}</button>}
      </aside>}
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
