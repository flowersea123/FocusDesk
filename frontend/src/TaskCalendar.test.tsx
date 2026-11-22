import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { CalendarSnapshot } from '../../contracts/calendar';
import TaskCalendar from './TaskCalendar';

const fixture: CalendarSnapshot = {
  today: '2026-11-16', timezone: 'Asia/Shanghai', revision: 'r1',
  entries: [{ id: 'src-' + 'a'.repeat(43), title: '学生周阅读材料', deviceTitle: 'Read student week brief', source: 'mail',
    sourceTitle: '学生周通知', plannedDate: '2026-11-17', dueDate: '2026-11-27', dueAt: null, status: 'scheduled' }],
};
function mount(day = '') {
  const changed = vi.fn();
  function Wrapper() {
    const [date, setDate] = useState(day);
    return <TaskCalendar active date={date} onDate={setDate} onChange={changed}/>;
  }
  render(<Wrapper/>);
  return changed;
}
afterEach(() => vi.unstubAllGlobals());
it('shows the mail on its planned day, keeps its date-only deadline and supports keyboard navigation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture)));
  const user = userEvent.setup(); mount();
  const today = await screen.findByRole('button', { name: '2026年11月16日，0 项待办' });
  expect(today).toHaveAttribute('aria-current', 'date');
  today.focus(); await user.keyboard('{ArrowRight}');
  const agenda = within(screen.getByRole('region', { name: '当日安排' }));
  expect(agenda.getByText('学生周阅读材料')).toBeVisible();
  expect(agenda.getByText('2026年11月27日')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '下个月' }));
  expect(agenda.getByText('这一天还没有安排。')).toBeVisible();
  expect(screen.getByRole('button', { name: '2026年12月17日，0 项待办' })).toHaveAttribute('aria-pressed', 'true');
});
it('changes only the planned day and follows the saved entry across months', async () => {
  let current = fixture;
  const fetch = vi.fn(async (_: string, options: RequestInit) => {
    if (options.method === 'PUT') {
      const body = JSON.parse(String(options.body));
      expect(body).toEqual({ revision: 'r1', entry: { id: fixture.entries[0].id, source: 'mail', sourceTitle: '学生周通知',
        title: '学生周阅读材料', deviceTitle: 'Read student week brief', plannedDate: '2026-12-01', dueDate: '2026-11-27', dueAt: null } });
      current = { ...fixture, revision: 'r2', entries: [{ ...body.entry, status: 'scheduled' }] };
    }
    return Response.json(current);
  });
  vi.stubGlobal('fetch', fetch); const user = userEvent.setup(); const changed = mount('2026-11-17');
  await user.click(await screen.findByRole('button', { name: '改期' }));
  fireEvent.change(screen.getByLabelText('新的计划日期'), { target: { value: '2026-12-01' } });
  await user.click(screen.getByRole('button', { name: '保存日期' }));
  expect(await screen.findByRole('heading', { name: 'December 1, 2026' })).toBeVisible();
  expect(changed).toHaveBeenCalledOnce();
});
it('uses the revision from the start of editing and refreshes after a conflicting change', async () => {
  let current = fixture;
  const fetch = vi.fn(async (_: string, options: RequestInit) => {
    if (options.method === 'DELETE') {
      expect(JSON.parse(String(options.body)).revision).toBe('r1');
      return Response.json({ error: '日历已更新，请重试。' }, { status: 409 });
    }
    return Response.json(current);
  });
  vi.stubGlobal('fetch', fetch); const user = userEvent.setup(); const changed = mount('2026-11-17');
  await user.click(await screen.findByRole('button', { name: '移除' }));
  current = { ...fixture, revision: 'r2', entries: [{ ...fixture.entries[0], title: '更新的阅读事项' }] };
  fireEvent.focus(window);
  await waitFor(() => expect(screen.getByRole('heading', { name: '更新的阅读事项' })).toBeVisible());
  await user.click(screen.getByRole('button', { name: '确认移除' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('日历已更新');
  expect(screen.getByRole('button', { name: '改期' })).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
});

it('creates and renames a manual Chinese entry using the same ID and selected day', async () => {
  let current: CalendarSnapshot = {...fixture,entries:[]};
  const writes: CalendarSnapshot['entries'] = [];
  vi.stubGlobal('fetch', async (_: string, options: RequestInit) => {
    if (options.method === 'PUT') {
      const body = JSON.parse(String(options.body));
      expect(body.revision).toBe(current.revision);
      writes.push(body.entry);
      current = {...current, revision:'after-'+writes.length, entries:[{...body.entry,status:'scheduled'}]};
    }
    return Response.json(current);
  });
  const user = userEvent.setup(); mount('2026-11-18');
  await user.click(await screen.findByRole('button',{name:/添加待办/}));
  fireEvent.change(screen.getByRole('textbox',{name:'新待办名称'}),{target:{value:'看论文'}});
  await user.click(screen.getByRole('button',{name:'保存待办'}));
  await user.click(await screen.findByRole('button',{name:'改名'}));
  fireEvent.change(screen.getByRole('textbox',{name:'待办名称'}),{target:{value:'Read methods'}});
  await user.click(screen.getByRole('button',{name:'保存名称'}));
  expect(writes).toHaveLength(2);
  expect(writes[0]).toMatchObject({source:'manual',title:'看论文',deviceTitle:'Kan lun wen',plannedDate:'2026-11-18'});
  expect(writes[1]).toMatchObject({id:writes[0].id,title:'Read methods',deviceTitle:'Read methods',plannedDate:'2026-11-18'});
});
