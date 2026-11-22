import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { FocusReview } from '../../contracts/focus-review';
import ActivityTimeline, { formatActivityDuration } from './ActivityTimeline';

const empty: FocusReview = {
  date:'2026-11-16', today:'2026-11-16', timezone:'Asia/Shanghai', trackingSince:'2026-11-15T00:00:00Z',
  partial:false, totalSeconds:0, sessions:[], observations:[], summary:'', suggestion:null, experiment:null, previousExperimentDate:null,
};
const paper = {taskId:'paper', title:'Read paper', from:'2026-11-16T01:00:00Z', to:'2026-11-16T01:25:00Z', seconds:1500, end:'expired' as const};
const at = (minute: string) => '2026-11-16T01:' + minute + ':00.000Z';

function renderDetailed(element: React.ReactElement) {
  const view = render(element);
  const switchView = () => {
    const button = screen.queryByRole('button',{name:'详细轨道'});
    if (button?.getAttribute('aria-pressed') === 'false') fireEvent.click(button);
  };
  switchView();
  return {...view, rerender(next:React.ReactElement) { view.rerender(next); switchView(); }};
}

describe('ActivityTimeline', () => {
  it('plots both kinds of intervals on one time scale, keeps their time separate, and exposes co-timed screenshots', async () => {
    const user = userEvent.setup();
    renderDetailed(<ActivityTimeline tasks={[{id:'paper',title:'Read paper'}]} review={{ ...empty,
      totalSeconds:1500, sessions:[paper], appSessions:[{appName:'Reader',from:at('10'),to:at('20'),seconds:600}],
      observations:[{id:'one',appName:'Reader',source:'automatic',at:at('10'),summary:'First page',taskId:'paper'},
        {id:'two',appName:'Reader',at:at('10'),summary:'Second image'},
        {id:'three',appName:'Editor',at:at('10'),summary:'Code lines'}] }} />);
    expect(screen.getByRole('button',{name:'查看 Read paper 的全部记录'})).toHaveTextContent('计时 25 分');
    expect(screen.getByRole('button',{name:'查看 Reader 的全部记录'})).toHaveTextContent('前台 10 分 · 2 条观察');
    const taskBar = within(screen.getByRole('group',{name:'Read paper 时间轨道'})).getByRole('button');
    const app = within(screen.getByRole('group',{name:'Reader 时间轨道'}));
    const appBar = app.getByRole('button',{name:/Reader · 前台 09:10–09:20/});
    const shots = app.getByRole('button',{name:'Reader · 09:10 · 2 条截图观察'});
    expect(taskBar.style.left).toBe('0%');
    expect(parseFloat(taskBar.style.width)).toBeCloseTo(100);
    expect(parseFloat(appBar.style.left)).toBeCloseTo(100 * 10 / 25);
    expect(parseFloat(shots.style.left) + parseFloat(shots.style.width) / 2).toBeCloseTo(parseFloat(appBar.style.left));
    expect(screen.getByText('最近记录')).toHaveTextContent('09:25');
    expect(within(screen.getByRole('group',{name:'Editor 时间轨道'})).getAllByRole('button')).toHaveLength(1);
    await user.click(shots);
    expect(screen.getByRole('heading',{name:'Reader · 2 条记录'})).toHaveFocus();
    expect(screen.getByText('First page')).toBeVisible(); expect(screen.getByText('Second image')).toBeVisible();
    expect(screen.getByText('自动记录 · Read paper')).toBeVisible(); expect(screen.getByText('手动确认')).toBeVisible();
    await user.keyboard('{Escape}'); expect(shots).toHaveFocus();
    await user.click(appBar); expect(screen.getByText('前台时段',{exact:false})).toBeVisible();
  });

  it('clips intervals to the Shanghai calendar day and omits neighbouring dates including the next midnight', async () => {
    const user = userEvent.setup();
    const begin = '2026-11-15T16:00:00Z', end = '2026-11-16T16:00:00Z';
    renderDetailed(<ActivityTimeline review={{...empty, sessions:[{...paper,from:'2026-11-15T15:55:00Z',to:'2026-11-15T16:10:00Z',seconds:900}],
      appSessions:[{appName:'Editor',from:'2026-11-16T15:58:00Z',to:'2026-11-16T16:10:00Z',seconds:720}],
      observations:[{id:'past',at:'2026-11-15T15:59:59Z',summary:'Yesterday',appName:'Invisible'},
        {id:'begin',at:begin,summary:'First point'}, {id:'end',at:end,summary:'Tomorrow',appName:'Invisible'}]}} />);
    expect(screen.getByLabelText('时间刻度')).toHaveTextContent('00:00');
    expect(screen.getByLabelText('时间刻度')).toHaveTextContent('24:00');
    expect(screen.queryByRole('group',{name:'Invisible 时间轨道'})).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'查看 Read paper 的全部记录'})).toHaveTextContent('计时 10 分');
    expect(screen.getByRole('button',{name:'查看 Editor 的全部记录'})).toHaveTextContent('前台 2 分');
    await user.click(screen.getByRole('button',{name:/Editor · 前台 23:58–24:00/}));
    expect(screen.getByText('23:58:00–24:00:00')).toBeVisible();
    expect(screen.getByRole('button',{name:'屏幕观察 · 00:00 · 1 条截图观察'})).toBeVisible();
  });

  it('keeps untimed legacy observations as timestamps, provides all entries in a dense cluster and expands additional application rows', async () => {
    const user = userEvent.setup();
    const points = Array.from({length:36}, (_,i) => ({id:'p'+i,at:at('10'),summary:'Item ' + (i+1)}));
    const apps = Array.from({length:7}, (_,i) => ({id:'app'+i,at:at('10'),appName:'App '+i,summary:'Sample '+i}));
    renderDetailed(<ActivityTimeline review={{...empty,observations:[...points,...apps]}}/>);
    expect(screen.getAllByRole('group', {name:/时间轨道/})).toHaveLength(5);
    const rowButton = screen.getByRole('button',{name:'查看 屏幕观察 的全部记录'});
    expect(rowButton).toHaveTextContent('36 条观察'); expect(rowButton).not.toHaveTextContent(/小时|秒|前台/);
    await user.click(screen.getByRole('button',{name:'屏幕观察 · 09:10:00 · 36 条截图观察'}));
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    await user.click(screen.getByRole('button',{name:'显示更多明细'}));
    expect(screen.getAllByRole('listitem')).toHaveLength(36);
    await user.click(screen.getByRole('button',{name:'显示另外 3 行'}));
    expect(screen.getAllByRole('group', {name:/时间轨道/})).toHaveLength(8);
  });

  it('adds fractional frontmost intervals before formatting time, while ignoring gaps between samples', async () => {
    const user = userEvent.setup();
    const appName = 'Reader';
    renderDetailed(<ActivityTimeline review={{...empty, appSessions:[
      {appName,from:'2026-11-16T06:00:00.000Z',to:'2026-11-16T06:00:00.730Z',seconds:.73},
      {appName,from:'2026-11-16T06:10:00.000Z',to:'2026-11-16T06:10:00.730Z',seconds:.73},
    ],observations:[{appName,id:'p',at:'2026-11-16T07:30:00Z',summary:'Single later sample'}]}} />);
    const row = screen.getByRole('button',{name:'查看 Reader 的全部记录'});
    expect(row).toHaveTextContent('前台 1 秒 · 1 条观察');
    await user.click(row); expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getAllByText(/不足 1 秒/)).toHaveLength(2);
    expect(screen.getByText('14:00:00.000–14:00:00.730')).toBeVisible();
    expect(formatActivityDuration(3599.999)).toBe('59 分 59 秒');
    expect(formatActivityDuration(3670.32)).toBe('1 小时 1 分');
  });

  it('reveals a hidden application from the recommendation, returns keyboard focus and accepts repeated requests', async () => {
    const user = userEvent.setup();
    const names = ['A', 'B', 'C', 'Code Editor', 'D', 'E', 'Preview'];
    const review = {...empty, observations:names.map(name => ({id:name, appName:name, at:at('10'), summary:'Sample ' + name}))};
    function Page() {
      const [request, update] = useState(0);
      return <><ActivityTimeline review={review} revealApp={request ? {name:'Preview',request} : null}/>
        <button type="button" onClick={() => update(i => i + 1)}>回看 Preview</button></>;
    }
    renderDetailed(<Page/>);
    expect(screen.queryByRole('group',{name:'Preview 时间轨道'})).not.toBeInTheDocument();
    const open = screen.getByRole('button',{name:'回看 Preview'});
    await user.click(open);
    const preview = screen.getByRole('group',{name:'Preview 时间轨道'});
    const code = screen.getByRole('group',{name:'Code Editor 时间轨道'});
    expect(preview.parentElement!.style.getPropertyValue('--activity-color')).not.toBe(code.parentElement!.style.getPropertyValue('--activity-color'));
    expect(screen.getByRole('heading',{name:'Preview · 1 条记录'})).toHaveFocus();
    expect(screen.getByText('Sample Preview')).toBeVisible();
    await user.keyboard('{Escape}'); expect(open).toHaveFocus();
    expect(screen.queryByText('Sample Preview')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading',{name:'Preview · 1 条记录'})).toHaveFocus();
    await user.click(screen.getByRole('button',{name:'收起明细'})); expect(open).toHaveFocus();
  });

  it('distinguishes loading, error and an empty day and keeps available evidence visible on refresh errors', async () => {
    const user = userEvent.setup(); const retry = vi.fn();
    const view = renderDetailed(<ActivityTimeline review={null}/>);
    expect(screen.getByRole('status')).toHaveTextContent('正在读取');
    view.rerender(<ActivityTimeline review={null} error="offline" onRetry={retry}/>);
    expect(screen.getByRole('alert')).toHaveTextContent('offline');
    expect(screen.queryByText(/今天还没有活动记录/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'重试'})); expect(retry).toHaveBeenCalledOnce();
    view.rerender(<ActivityTimeline review={empty}/>);
    expect(screen.getByText(/今天还没有活动记录/)).toBeVisible();
    view.rerender(<ActivityTimeline review={{...empty,sessions:[paper]}} error="offline" onRetry={retry}/>);
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByRole('button',{name:/Read paper · 计时 09:00–09:25/})).toBeVisible();
  });
});

it('shows simultaneous AI runs independently of the person and preserves the end state of each run', async () => {
  const user = userEvent.setup();
  renderDetailed(<ActivityTimeline review={{...empty, sessions:[paper], appSessions:[{appName:'Editor',from:at('05'),to:at('20'),seconds:900}],
    aiSessions:[{appName:'Codex',title:'轮次 A',runId:'a',from:at('06'),to:at('16'),state:'finished'},
      {appName:'ChatGPT',title:'网页生成 B',runId:'b',from:at('06'),to:at('16'),state:'running'}]}}/>);
  const first = within(screen.getByRole('group',{name:'Codex · 轮次 A 时间轨道'})).getByRole('button');
  const second = within(screen.getByRole('group',{name:'ChatGPT · 网页生成 B 时间轨道'})).getByRole('button');
  expect(first.style.left).toBe(second.style.left);
  expect(first.style.width).toBe(second.style.width);
  expect(first).toHaveAccessibleName(/AI 活动.*10 分/);
  expect(screen.getByRole('button',{name:'查看 Editor 的全部记录'})).toHaveTextContent('前台 15 分');
  await user.click(first);
  const details = screen.getByRole('heading',{name:'Codex · 轮次 A · 1 条记录'}).parentElement!.parentElement!;
  expect(within(details).getByRole('list')).toHaveTextContent('已结束');
});

it('groups consecutive automatic screenshots into evidence windows without filling interruptions or crediting focus', async () => {
  const user = userEvent.setup();
  const shot = (id:string, sec:number, appName = 'Reader', source:'automatic'|'manual' = 'automatic') => ({id, appName, source,
    at:new Date(Date.parse(at('00')) + sec * 1000).toISOString(), summary:'Screenshot ' + id});
  renderDetailed(<ActivityTimeline review={{...empty, observations:[
    shot('a',0), shot('b',45), shot('c',90), shot('other',92,'Editor'), shot('d',95), shot('e',100),
    shot('manual',102,'Reader','manual'), shot('f',110), shot('g',115), shot('h',180), shot('i',183),
  ], appSessions:[{appName:'Editor',from:'2026-11-16T01:01:36Z',to:'2026-11-16T01:01:37Z',seconds:1}]}}/>);
  const track = screen.getByRole('group',{name:'Reader 时间轨道'});
  expect(track.querySelectorAll('.activity-observed')).toHaveLength(3);
  const first = within(track).getByRole('button',{name:/09:00:00–09:01:30 · 3 条截图观察/});
  await user.click(first);
  expect(screen.getByText(/仅表示首次至末次观察/)).toHaveTextContent('3 张截图');
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(screen.getByRole('button',{name:'查看 Reader 的全部记录'})).not.toHaveTextContent('前台');
});

it('magnifies a short measured interval on a long day with parallel rows on the same scale', async () => {
  const user = userEvent.setup();
  const from = '2026-11-16T09:00:00Z', to = '2026-11-16T09:00:08Z';
  renderDetailed(<ActivityTimeline review={{...empty, sessions:[paper],appSessions:[{appName:'Editor',from,to,seconds:8}],
    aiSessions:[{appName:'Codex',title:'A',runId:'x',from,to,state:'finished'}]}}/>);
  const track = screen.getByRole('group',{name:'Editor 时间轨道'});
  const bar = within(track).getByRole('button');
  expect(parseFloat(bar.style.width)).toBeCloseTo(5);
  await user.click(bar);
  await user.click(screen.getByRole('button',{name:'放大这个时段'}));
  expect(parseFloat(within(track).getByRole('button').style.width)).toBeCloseTo(40);
  const ai = within(screen.getByRole('group',{name:'Codex · A 时间轨道'})).getByRole('button');
  expect(ai.style.width).toBe(within(track).getByRole('button').style.width);
  expect(within(screen.getByRole('group',{name:'Read paper 时间轨道'})).queryByRole('button')).toBeNull();
  const reset = screen.getByRole('button',{name:'返回全天'});
  expect(reset).toHaveFocus();
  await user.click(reset);
  expect(parseFloat(within(track).getByRole('button').style.width)).toBeCloseTo(5);
});

it('shows one named conversation and one summary for overlapping worker activity and two user turns', async () => {
  const user = userEvent.setup();
  const flags={appName:'Codex',title:'轮次 c0eb5d',conversationTitle:'阅读进展',conversationId:'paper-chat',state:'finished' as const};
  const {container}=renderDetailed(<ActivityTimeline review={{...empty, aiSessions:[
    {...flags,runId:'p',conversationTurnId:'q1',from:at('01'),to:at('04'),userExcerpt:'从哪一章继续？'},
    {...flags,runId:'helper',conversationTurnId:'q1',from:at('03'),to:at('05'),assistantExcerpt:'接着看方法章节。'},
    {...flags,runId:'p2',conversationTurnId:'q2',from:at('08'),to:at('09'),userExcerpt:'对照第二个实验。'},
  ],aiConversationSummaries:{'Codex:chat:paper-chat':'讨论从方法章节继续阅读，并核对第二个实验。'}}}/>);
  expect(screen.getAllByRole('group',{name:/时间轨道/})).toHaveLength(1);
  expect(screen.queryByText('对话小结')).toBeNull();
  expect(screen.queryByText(/c0eb5d/)).toBeNull();
  const name=screen.getByRole('button',{name:'查看 Codex · 阅读进展 的全部记录'});
  expect(name).toHaveTextContent('2 轮');expect(name).toHaveTextContent('AI 活动 5 分');
  expect(container.querySelectorAll('.activity-chat-active')).toHaveLength(2);
  await user.click(name);expect(screen.getByRole('heading',{name:'Codex · 阅读进展 · 2 轮对话'})).toBeVisible();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.queryByText('接着看方法章节。')).toBeNull();
  await user.click(screen.getByRole('button',{name:'查看对话摘录'}));
  expect(screen.getByText('对话小结')).toBeVisible();
  expect(screen.getByText('接着看方法章节。')).toBeVisible();
  await user.click(screen.getByRole('button',{name:'收起对话摘录'}));
  expect(screen.queryByText('接着看方法章节。')).toBeNull();
});

it('opens with a compact activity overview, splits verified site visits from the browser, and keeps search and source details available', async () => {
  const user = userEvent.setup();
  const appName='Google Chrome';
  const minute=(sec:number)=>new Date(Date.parse(at('00'))+sec*1000).toISOString();
  const observation=(id:string,sec:number,pageTitle:string)=>({id,at:minute(sec),appName,pageTitle,source:'automatic' as const,summary:'屏幕观察 '+id});
  render(<ActivityTimeline review={{...empty,appSessions:[{from:minute(0),to:minute(120),appName,seconds:120}],
    observations:[observation('one',15,'Section One | alphaXiv'),observation('two',55,'Section Two | alphaXiv'),
      observation('editor',70,'Notebook'),observation('solo',90,'Section Three | alphaXiv')],
    aiSessions:[{appName:'Codex',runId:'c1',conversationId:'one',conversationTitle:'核对方法',title:'方法',from:minute(0),to:minute(80),state:'finished'},
      {appName:'Codex',runId:'c2',conversationId:'two',conversationTitle:'整理文献',title:'文献',from:minute(80),to:minute(120),state:'finished'}]
  }}/>);
  expect(screen.getByRole('button',{name:'活动总览'})).toHaveAttribute('aria-pressed','true');
  expect(screen.queryByRole('button',{name:'查看对话摘录'})).toBeNull();
  expect(screen.getAllByRole('group',{name:/^Codex 活动$/})).toHaveLength(1);
  expect(screen.getByRole('button',{name:'浏览 Google Chrome 活动'})).toHaveTextContent('1 分 20 秒');
  expect(screen.getByRole('button',{name:'浏览 alphaxiv.org 活动'})).toHaveTextContent('观察跨度 40 秒');
  const chromeTrack=within(screen.getByRole('group',{name:'Google Chrome 活动'}));
  await user.click(chromeTrack.getByRole('button',{name:/09:00:00–09:00:15/}));
  expect(screen.getByText('09:00:00–09:00:15')).toBeVisible();
  const site=within(screen.getByRole('group',{name:'alphaxiv.org 活动'}));
  const block=site.getByRole('button',{name:/09:00:15–09:00:55.*Section One/});
  expect(block).toHaveTextContent('Section One');
  expect(site.getAllByRole('button')).toHaveLength(2);
  await user.click(block);
  expect(screen.getByText('屏幕观察 two')).toBeVisible();
  expect(screen.getByRole('heading',{name:'alphaxiv.org · 2 条记录'})).toBeVisible();
  await user.click(screen.getByRole('button',{name:'查找活动'}));
  await user.type(screen.getByRole('searchbox',{name:'搜索活动'}),'整理文献');
  const hit=screen.getByRole('button',{name:/09:01:20–09:02:00 整理文献/});
  await user.click(hit);
  expect(screen.getByRole('heading',{name:'Codex · 整理文献 · 1 轮对话'})).toHaveFocus();
});

it('shows a standalone browser-title observation as an instant and avoids deriving sites from arbitrary summaries', () => {
  render(<ActivityTimeline review={{...empty, observations:[
    {id:'a',appName:'Safari',at:at('10'),summary:'Safari 的前台页面标题为「Paper | alphaXiv」。'},
    {id:'b',appName:'Safari',at:at('11'),summary:'正在讨论 example.com 和 alphaXiv'}]}}/>);
  expect(screen.getByRole('button',{name:'浏览 alphaxiv.org 活动'})).toHaveTextContent('仅有采样时刻');
  expect(screen.queryByRole('button',{name:'浏览 example.com 活动'})).toBeNull();
  expect(screen.getByRole('button',{name:'浏览 Safari 活动'})).toBeVisible();
});

it('keeps a short website reading visible on a busy day and lets the time cursor inspect unobserved gaps', async () => {
  const user=userEvent.setup();
  const apps=['Editor','Notes','Terminal','Mail','Preview','Google Chrome'];
  const appSessions=apps.map((appName,index)=>({appName,from:at(String(index*5).padStart(2,'0')),to:at(String(index*5+4).padStart(2,'0')),seconds:240}));
  const observation=(id:string,at:string)=>({id,appName:'Google Chrome',at,summary:'查看论文',pageTitle:'Reading methods | alphaXiv',source:'manual' as const});
  render(<ActivityTimeline review={{...empty,appSessions,observations:[
    observation('first',at('26')),observation('second',at('27'))]}}/>);
  const site=screen.getByRole('group',{name:'alphaxiv.org 活动'});
  expect(screen.getByRole('button',{name:'浏览 alphaxiv.org 活动'})).toHaveTextContent('仅有采样时刻');
  expect(within(site).getByRole('button',{name:'09:27 Reading methods'})).toBeVisible();
  const cursor=screen.getByRole('slider',{name:'浏览时间轴时刻'});
  fireEvent.change(cursor,{target:{value:String(Date.parse(at('04'))+30000)}});
  expect(screen.getByText('这段时间没有记录')).toBeVisible();
  await user.click(screen.getByRole('button',{name:'下一时段'}));
  expect(cursor).toHaveAttribute('aria-valuetext','09:05:00');
});
