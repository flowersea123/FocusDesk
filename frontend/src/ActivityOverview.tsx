import { useMemo, useState, type CSSProperties, type RefObject } from 'react';
import type { TimelineEntry as Entry, TimelineTrack as Track } from './ActivityTimeline';

type Block = {
  row: Track;
  entries: Entry[];
  start: number;
  end: number;
  label: string;
  kind: 'app' | 'site' | 'ai' | 'focus' | 'sample';
};
interface Lane { key:string; title:string; blocks:Block[]; color:string }
const palette = ['#62615c','#9c9a91','#4f4e49','#85847b','#74736d','#aaa89e','#54534f'];
const browserName = /^(?:(?:Google )?Chrome(?: Canary)?|Chromium|(?:Microsoft )?Edge|Firefox|Safari(?: Technology Preview)?|Arc|Brave(?: Browser)?|Vivaldi|夸克|浏览器)$/i;

function pageIdentity(title:string) {
  const clean = title.replace(/\s+(?:[-–—|])\s+(Google Chrome|Microsoft Edge|Mozilla Firefox|Brave|Chromium|Safari)(?:\s.*)?$/i,'').trim();
  const parts = clean.split(/\s+[|｜–—-]\s+|\s*[|｜]\s*/u);
  const suffix = parts.at(-1)?.trim() ?? '';
  const domain = /^(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d+)?(?:[/?#][^\s]*)?$/i;
  const site = /^alphaxiv$/i.test(suffix) ? 'alphaxiv.org' : domain.exec(suffix)?.[1]?.toLowerCase().replace(/^www\./,'');
  return { site, title: (site && parts.length > 1 ? parts.slice(0,-1).join(' · ') : clean) };
}

function sourceOf(point:Entry, app:string) {
  const prefix = app + ' 的前台页面标题为「';
  const archivedTitle = point.detail.startsWith(prefix) && point.detail.endsWith('」。') ? point.detail.slice(prefix.length,-2) : '';
  const title = point.pageTitle || archivedTitle || /^(?:窗口标题|页面标题|Window title)\s*[：:]\s*(.+)$/i.exec(point.detail)?.[1] || '';
  return pageIdentity(title);
}

function elapsed(blocks:Block[]) {
  let seconds = 0, end = -Infinity;
  for (const b of blocks) {
    seconds += Math.max(0, b.end - Math.max(end,b.start)) / 1000;
    end = Math.max(end,b.end);
  }
  return seconds;
}

function buildLanes(rows:Track[], taskNames: Map<string,string>) {
  const lanes = new Map<string,Lane>();
  function add(key:string, title:string, block:Block) {
    let lane = lanes.get(key);
    if (!lane) {
      const slot = Array.from(key).reduce((sum,c) => sum + c.codePointAt(0)!,0) % palette.length;
      const color = block.kind === 'focus' ? 'var(--yellow)' : block.kind === 'site' ? '#74736d' : block.kind === 'ai' ? 'var(--ink)' : palette[slot];
      lane = {key,title,color,blocks:[]};
      lanes.set(key,lane);
    }
    lane.blocks.push(block);
  }
  for (const row of rows) {
    const chat = row.conversation;
    if (chat) {
      const entries = row.entries;
      for (const window of chat.windows) {
        const matching = entries.filter(e => e.start <= window.to && e.end >= window.from);
        if (!matching.length) continue;
        const start = Math.max(window.from,matching[0].start), end = Math.min(window.to,matching.at(-1)!.end);
        add('app:'+chat.appName, chat.appName, {row,entries:matching,start,end,kind:'ai',label:chat.title});
      }
      continue;
    }
    const points = row.entries.filter(e => e.kind === 'observation');
    const spans = row.entries.filter(e => e.kind !== 'observation');
    const siteById = new Map<string,string>();
    if (browserName.test(row.name)) {
      for (const p of points) {
        const site = sourceOf(p,row.name).site;
        if (site) siteById.set(p.id,site);
      }
    }
    function caption(point:Entry | undefined) {
      if (!point) return row.name;
      return sourceOf(point,row.name).title || (point.taskId && taskNames.get(point.taskId)) || point.detail;
    }
    const handled = new Set<string>();
    let pointIndex = 0;
    for (const e of spans) {
      if (row.kind === 'focus') {
        add(row.id,row.name,{row,entries:[e],start:e.start,end:e.end,kind:'focus',label:row.name});
        continue;
      }
      while (pointIndex < points.length && points[pointIndex].start < e.start) pointIndex++;
      const samples: Entry[] = [];
      for (let j=pointIndex; j<points.length && points[j].start <= e.end; j++) {
        if (!handled.has(points[j].id)) { samples.push(points[j]); handled.add(points[j].id); }
      }
      // A site can account only for the span between adjacent automatic samples inside this foreground interval.
      const visits:{site:string; points:Entry[]}[] = [];
      for (let i=0;i<samples.length;i++) {
        const sample=samples[i], site=siteById.get(sample.id);
        if (!site) continue;
        const prev=visits.at(-1), last=prev?.points.at(-1);
        if (prev?.site === site && last && last === samples[i-1] && sample.observationGroup === last.observationGroup) prev.points.push(sample);
        else visits.push({site,points:[sample]});
      }
      let cursor=e.start;
      function appBlock(end:number) {
        if (end<=cursor) return;
        const observed=samples.filter(p => !siteById.has(p.id) && p.start>=cursor && p.start<=end);
        add(row.id,row.name,{row,kind:'app',start:cursor,end,entries:[e,...observed],label:caption(observed[0])});
      }
      for (const v of visits) {
        const first=v.points[0], last=v.points.at(-1)!;
        add('site:'+v.site,v.site,{row,kind:'site',start:first.start,end:last.start,entries:v.points,label:caption(first)});
        if (last.start>first.start) { appBlock(first.start); cursor=last.start; }
      }
      appBlock(e.end);
      if(e.start===e.end) add(row.id,row.name,{row,kind:'sample',start:e.start,end:e.end,entries:[e],label:row.name});
    }
    for (const p of points) {
      if (handled.has(p.id)) continue;
      const site=siteById.get(p.id);
      add(site?'site:'+site:row.id,site || row.name,{row,kind:'sample',start:p.start,end:p.end,entries:[p],label:caption(p)});
    }
  }
  for (const lane of lanes.values()) lane.blocks.sort((a,b)=>a.start-b.start || a.end-b.end);
  const total=(l:Lane)=>elapsed(l.blocks);
  return [...lanes.values()].sort((a,b)=>Number(b.key.startsWith('task:'))-Number(a.key.startsWith('task:')) || total(b)-total(a) || b.blocks.at(-1)!.end-a.blocks.at(-1)!.end);
}

const kindName = {app:'前台',site:'站点观察',ai:'AI 活动',focus:'任务计时',sample:'观察'};
const keyOf = (b:Block) => [b.row.id,b.entries[0].id,b.start,b.end].join(':');
function groupsFor(blocks:Block[], start:number, end:number, width:number) {
  type Mark = { b:Block; left:number; right:number };
  const groups:{left:number;right:number;marks:Mark[]}[]=[];
  for (const b of blocks) {
    if (b.end<start || b.start>end) continue;
    const left=Math.max(0,Math.min(width-3,width*(b.start-start)/(end-start)));
    const right=Math.min(width,Math.max(left+3,width*(b.end-start)/(end-start)));
    const g=groups.at(-1), mark={b,left,right};
    if (g && left<g.right) { g.right=Math.max(right,g.right); g.marks.push(mark); }
    else groups.push({left,right,marks:[mark]});
  }
  return groups;
}

interface Props {
  rows:Track[]; tasks?:readonly {id:string;title:string}[]; start:number; end:number; latest:number; plotWidth:number;
  time:(at:number,seconds?:boolean)=>string; ruler:RefObject<HTMLDivElement | null>; duration:(seconds:number)=>string;
  select:(button:HTMLButtonElement,id:string,entries?:Entry[],excerpts?:boolean,range?:{start:number;end:number},heading?:string)=>void;
  detailsId:string;
}

export default function ActivityOverview({rows,tasks,start,end,latest,plotWidth,time,ruler,duration,select,detailsId}:Props) {
  const lanes=useMemo(()=>buildLanes(rows,new Map(tasks?.map(t=>[t.id,t.title]))),[rows,tasks]);
  const [expanded,setExpanded]=useState(false);
  const [choices,setChoices]=useState<Block[]>([]);
  const [cursor,setCursor]=useState<number | null>(null);
  const events=useMemo(()=>lanes.flatMap(l=>l.blocks.map(b=>({b,name:l.title})))
    .sort((a,b)=>a.b.start-b.b.start || a.b.end-b.b.end),[lanes]);
  const position=Math.min(end,Math.max(start,cursor ?? latest));
  const priority={site:0,sample:1,app:2,focus:3,ai:4};
  const active=events.filter(({b})=>b.start<=position && b.end>=position)
    .sort((a,b)=>priority[a.b.kind]-priority[b.b.kind] || b.b.start-a.b.start);
  const current=active[0];
  const times=useMemo(()=>[...new Set(events.map(({b})=>b.start).filter(t=>t>=start && t<=end))],[events,start,end]);
  const nextIndex=times.findIndex(t=>t>=position);
  const previous=nextIndex<0 ? times.at(-1) : times[nextIndex-1];
  const next=times.find(t=>t>position);
  const [query,setQuery]=useState('');
  const [searching,setSearching]=useState(false);
  const terms=query.trim().toLocaleLowerCase();
  const results=useMemo(()=>terms ? lanes.flatMap(l=>l.blocks.filter(b=>[l.title,b.label,...b.entries.flatMap(e=>[e.detail,e.pageTitle ?? ''])].some(v=>v.toLocaleLowerCase().includes(terms)))).sort((a,b)=>b.end-a.end) : [],[lanes,terms]);
  const visible=expanded ? lanes : lanes.slice(0,5);
  // Keep a confirmed website visible even when several applications accumulated more time.
  const site=lanes.find(l=>l.key.startsWith('site:'));
  if (!expanded && site && !visible.includes(site)) visible[visible.length-1]=site;
  const span=end-start;
  const steps=[1000,5000,10000,15000,30000,60000,5*60000,15*60000,30*60000,3600000,2*3600000,3*3600000,6*3600000,12*3600000];
  const step=steps.find(s=>s>=span/Math.max(2,Math.min(6,Math.floor(plotWidth/85)))) ?? steps.at(-1)!;
  const ticks=[start];
  for (let t=start+step;t<end-step*.4;t+=step) ticks.push(t);
  ticks.push(end);
  function open(button:HTMLButtonElement,b:Block) {
    setCursor(b.start);
    const range=b.kind==='app' ? {start:b.start,end:b.end} : undefined;
    const heading=b.kind==='site' ? sourceOf(b.entries[0],b.row.name).site : undefined;
    select(button,b.row.id,b.entries,Boolean(b.row.conversation?.linked),range,heading);
  }
  const all=terms?results:choices;
  return <>
    <div className="overview-tools">
      <span>最近记录 <time>{time(latest,false)}</time></span>
      <button type="button" className="overview-search-button" aria-expanded={searching} onClick={()=>{setSearching(!searching);setQuery('');setChoices([]);}}>查找活动</button>
    </div>
    {searching && <input autoFocus className="overview-search" type="search" placeholder="搜索应用、网页标题或活动" aria-label="搜索活动" value={query} onChange={e=>setQuery(e.target.value)}/>}
    <div className="activity-grid overview-grid">
      <span className="activity-axis-heading">活动</span>
      <div className="activity-axis overview-axis" ref={ruler} aria-label="时间刻度">{ticks.map(t=><span key={t} style={{left:100*(t-start)/span+'%'}}>{time(t)}</span>)}
        <input type="range" aria-label="浏览时间轴时刻" aria-valuetext={time(position,true)} min={start} max={end} step={Math.min(1000,span/1000)} value={position}
          onChange={e=>setCursor(Number(e.target.value))} title="拖动浏览这个时刻"/>
      </div>
      {visible.map(lane=>{
        const foreground=lane.blocks.filter(b=>b.kind==='app'), ai=lane.blocks.filter(b=>b.kind==='ai');
        const mixed=foreground.length>0 && ai.length>0;
        const total=elapsed(lane.blocks);
        const metric=mixed ? '前台 '+duration(elapsed(foreground))+' · AI '+duration(elapsed(ai)) : total ? (lane.key.startsWith('site:') ? '观察跨度 ' : ai.length ? 'AI ' : '')+duration(total) : '仅有采样时刻';
        const sourceMetric=lane.key==='site:alphaxiv.org' ? '论文站 · '+metric : metric;
        const bands=mixed ? [lane.blocks.filter(b=>b.kind!=='ai'),ai] : [lane.blocks];
        const visibleBlocks=lane.blocks.filter(b=>b.end>=start && b.start<=end);
        const shortOnly=visibleBlocks.every(b=>(Math.min(end,b.end)-Math.max(start,b.start))*plotWidth/span < 62);
        const example=shortOnly ? [...visibleBlocks].reverse().find(b=>b.label!==lane.title) : undefined;
        return <div className="activity-row overview-row" key={lane.key} style={{'--activity-color':lane.color} as CSSProperties}>
          <button type="button" className="activity-name" title={lane.title+' · '+sourceMetric} aria-label={'浏览 '+lane.title+' 活动'} onClick={()=>{setQuery('');setChoices([...lane.blocks].reverse());}}>
            <strong>{lane.title}</strong><small>{sourceMetric}</small>
          </button>
          <div className={'overview-track'+(mixed?' overview-mixed':'')} role="group" aria-label={lane.title+' 活动'}>
            <i aria-hidden="true" className="activity-latest-line" style={{left:100*(position-start)/span+'%'}}/>
            {bands.map((band,i)=><div className="overview-band" key={i}>{groupsFor(band,start,end,plotWidth).map(g=>{
              const items=g.marks.map(m=>m.b), first=items[0], longest=g.marks.reduce((a,b)=>b.right-b.left>a.right-a.left?b:a);
              const title=longest.b.label;
              const last=Math.max(...items.map(b=>b.end));
              const range=time(first.start,true)+(first.start===last?'':'–'+time(last,true));
              const label=range+' · '+lane.title+' · '+title+(items.length>1?' · '+items.length+' 段':'');
              return <button type="button" key={keyOf(first)} className={'overview-block'+(first.start===first.end && items.length===1?' overview-point':'')} title={label} aria-label={label} aria-controls={detailsId}
                style={{left:100*g.left/plotWidth+'%',width:100*(g.right-g.left)/plotWidth+'%'}}
                onClick={e=>{if(items.length===1) open(e.currentTarget,first); else {setChoices(items);setQuery('');}}}>
                {g.marks.map(m=><i aria-hidden="true" key={keyOf(m.b)} style={{left:100*(m.left-g.left)/(g.right-g.left)+'%',width:100*(m.right-m.left)/(g.right-g.left)+'%'}}/>)}
                {longest.right-longest.left>=62 && <span aria-hidden="true" style={{left:100*(longest.left-g.left)/(g.right-g.left)+'%',width:100*(longest.right-longest.left)/(g.right-g.left)+'%'}}>{title}</span>}
              </button>;
            })}</div>)}
            {example && <button type="button" className="overview-caption" onClick={e=>open(e.currentTarget,example)} title={example.label}>
              <time>{time(example.start,false)}</time> {example.label}
            </button>}
          </div>
        </div>;
      })}
    </div>
    <div className="overview-moment">
      <time>{time(position,true)}</time>
      {current ? <button type="button" className="overview-moment-title" title={current.b.label}
        onClick={e=>{if(active.length>1){setChoices(active.map(x=>x.b));setQuery('');}else open(e.currentTarget,current.b);}}>
        {current.name}{current.b.label!==current.name && ' · '+current.b.label}{active.length>1 && <small> +{active.length-1}</small>}
      </button> : <span>这段时间没有记录</span>}
      <nav aria-label="按时间浏览活动">
        <button type="button" aria-label="上一时段" disabled={previous===undefined} onClick={()=>setCursor(previous!)}>‹</button>
        <button type="button" aria-label="下一时段" disabled={next===undefined} onClick={()=>setCursor(next!)}>›</button>
      </nav>
    </div>
    {lanes.length>5 && <button type="button" className="activity-more" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'收起活动':'显示另外 '+(lanes.length-5)+' 项活动'}</button>}
    {(terms || choices.length>0) && <BlockResults key={terms || choices.map(keyOf).join(',')} items={all} time={time} open={open} close={()=>{setChoices([]);setQuery('');}} search={!!terms}/>}
  </>;
}

function BlockResults({items,time,open,close,search}:{items:Block[];time:Props['time'];open:(b:HTMLButtonElement,item:Block)=>void;close:()=>void;search:boolean}) {
  const [limit,setLimit]=useState(12);
  return <div className="overview-results"><header><b>{search?'搜索结果':'活动时段'} · {items.length}</b><button className="activity-more" onClick={close}>关闭</button></header>
    {items.length===0 && <p>没有找到匹配的活动。</p>}
    {items.slice(0,limit).map(b=><button className="overview-result" key={keyOf(b)} onClick={e=>open(e.currentTarget,b)}>
      <time>{time(b.start,true)}{b.end!==b.start && '–'+time(b.end,true)}</time><strong>{b.label}</strong><small>{kindName[b.kind]} · {b.row.conversation?.appName || b.row.name}</small>
    </button>)}
    {items.length>limit && <button className="activity-more" onClick={()=>setLimit(limit+24)}>显示更多时段</button>}
  </div>;
}
