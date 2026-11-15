import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import ScreenObservation from './ScreenObservation';

const result = { summary: '已完成引言和方法。', nextStep: '写讨论。', progress: { percent: 75, evidence: '3/4 completed' },
  completedParts: ['Introduction', 'Method'] };
const tasks = [{id: 'lab',title: 'Lab Report'}];

function camera() {
  const stop = vi.fn();
  const track = Object.assign(new EventTarget(), { stop, readyState: 'live' });
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const getDisplayMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('navigator', Object.create(navigator, { mediaDevices: { value: { getDisplayMedia } } }));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(3000);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(1500);
  const drawImage = vi.fn();
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({fillRect: vi.fn(),drawImage} as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,pixels');
  return { track, stop, getDisplayMedia, drawImage, stream };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button',{name})); }); };

test('single capture releases tracks, resizes the frame, and saves only confirmed, editable text', async () => {
  const { stop, drawImage, getDisplayMedia } = camera();
  const post = vi.fn().mockImplementation(async () => Response.json(result));
  vi.stubGlobal('fetch',post);
  const onSave = vi.fn();
  render(<ScreenObservation tasks={tasks} onSave={onSave}/>);
  expect(getDisplayMedia).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('关联任务'), { target:{value:'lab'} });
  await click('截取一次');
  expect(getDisplayMedia).toHaveBeenCalledWith({video:true,audio:false});
  expect(drawImage.mock.calls[0].slice(1)).toEqual([0,0,1440,720]);
  expect(stop).toHaveBeenCalledOnce();
  expect(onSave).not.toHaveBeenCalled();
  expect(JSON.parse(post.mock.calls[0][1].body).taskId).toBe('lab');
  fireEvent.change(screen.getByLabelText('工作摘要'),{target:{value:'本人核对的摘要'}});
  fireEvent.change(screen.getByLabelText(/已完成的具体部分/),{target:{value:'Method\nResults'}});
  fireEvent.click(screen.getByRole('checkbox', { name: /保存画面/ }));
  await click('确认并保存');
  expect(onSave).toHaveBeenCalledWith({source:'manual',capturedAt:expect.any(String),taskId:'lab',summary:'本人核对的摘要',
    nextStep:result.nextStep,progress:null,completedParts:['Method','Results']});
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

test('periodic capture retains only untouched drafts; a late inference cannot replace edits and stop ends all tracks', async () => {
  vi.useFakeTimers();
  const { stop } = camera();
  let respond!: (value: Response) => void;
  const post = vi.fn().mockImplementationOnce(async()=>Response.json(result))
    .mockImplementationOnce(()=>new Promise(resolve=>{ respond=resolve; }))
    .mockImplementation(async()=>Response.json(result));
  vi.stubGlobal('fetch',post);
  const onSave = vi.fn();
  render(<ScreenObservation tasks={tasks} onSave={onSave}/>);
  await click('每分钟采样');
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
  expect(post).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText('工作摘要'),{target:{value:'人工编辑中'}});
  await act(async()=>{respond(Response.json({...result,summary:'稍后的识别'}));});
  await act(async()=>{await vi.advanceTimersByTimeAsync(120_000);});
  expect(screen.getByLabelText('工作摘要')).toHaveValue('人工编辑中');
  expect(post).toHaveBeenCalledTimes(2);
  await click('放弃草稿');
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
  expect(post).toHaveBeenCalledTimes(3);
  await click('停止采样');
  await act(async()=>{await vi.advanceTimersByTimeAsync(120_000);});
  expect(stop).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledTimes(3);
  expect(onSave).not.toHaveBeenCalled();
});

test('unmount and cancellation during the picker release a late stream without taking a frame', async () => {
  const { getDisplayMedia, stop, stream }=camera();
  let grant!: (value:unknown)=>void;
  getDisplayMedia.mockImplementationOnce(()=>new Promise(resolve=>{grant=resolve;}));
  const post=vi.fn();
  vi.stubGlobal('fetch',post);
  const view=render(<ScreenObservation tasks={[]} onSave={vi.fn()}/>);
  await click('每分钟采样');
  view.unmount();
  await act(async()=>{grant(stream);});
  expect(stop).toHaveBeenCalledOnce();
  expect(post).not.toHaveBeenCalled();
});

test('upload decodes without a sharing request and a dismissed draft saves no content', async () => {
  const { getDisplayMedia }=camera();
  const revoke=vi.fn();
  class LocalURL extends URL { static createObjectURL = vi.fn(()=>'blob:fixture'); static revokeObjectURL = revoke; }
  vi.stubGlobal('URL', LocalURL);
  vi.stubGlobal('Image', class { naturalWidth=320; naturalHeight=190; src=''; async decode() {} });
  const post=vi.fn().mockResolvedValue(Response.json({...result,progress:null}));
  vi.stubGlobal('fetch',post);
  const onSave=vi.fn();
  render(<ScreenObservation tasks={[]} onSave={onSave}/>);
  await act(async()=>{fireEvent.change(screen.getByLabelText('选择截图文件'),{target:{files:[new File(['test'],'check.png',{type:'image/png'})]}});});
  expect(getDisplayMedia).not.toHaveBeenCalled();
  expect(revoke).toHaveBeenCalledWith('blob:fixture');
  expect(JSON.parse(post.mock.calls[0][1].body)).toEqual({taskId:null,image:'data:image/jpeg;base64,pixels'});
  await click('放弃草稿');
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('工作摘要')).not.toBeInTheDocument();
});

test('per-session opt-in saves changed observations, skips static frames and equivalent text, and keeps unknown progress unknown', async () => {
  vi.useFakeTimers();
  camera();
  vi.stubGlobal('crypto', { subtle: { digest: async (_name: string, bytes: Uint8Array) => bytes } });
  const frame = (n: number) => 'data:image/jpeg;base64,frame' + n;
  vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockReturnValueOnce(frame(1)).mockReturnValueOnce(frame(1))
    .mockReturnValueOnce(frame(2)).mockReturnValueOnce(frame(3)).mockReturnValue(frame(4));
  const unknown = {summary:'屏幕显示一份未标记进度的草稿。', nextStep:'', completedParts:[], progress:null};
  const post = vi.fn().mockImplementationOnce(async()=>Response.json(result))
    .mockImplementationOnce(async()=>Response.json({...result, completedParts:[...result.completedParts].reverse(), nextStep:'另一个建议。'}))
    .mockImplementationOnce(async()=>Response.json(unknown))
    .mockImplementationOnce(async()=>Response.json({...unknown, progress:{ percent:'75', evidence:'' }}))
    .mockImplementation(async()=>Response.json(result));
  vi.stubGlobal('fetch', post);
  const onSave = vi.fn();
  render(<ScreenObservation tasks={tasks} onSave={onSave}/>);
  const option = screen.getByLabelText('周期采样时自动记录');
  expect(option).toBeDisabled();
  fireEvent.change(screen.getByLabelText('关联任务'), {target:{value:'lab'}});
  expect(option).not.toBeChecked();
  fireEvent.click(option);
  expect(post).not.toHaveBeenCalled();
  await click('每分钟采样');
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0][0]).toEqual({...result, capturedAt:expect.any(String), taskId:'lab', source:'automatic'});
  expect(JSON.parse(post.mock.calls[0][1].body).automatic).toBe(true);
  expect(screen.queryByLabelText('工作摘要')).not.toBeInTheDocument();
  const next = () => act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
  await next(); expect(post).toHaveBeenCalledTimes(1);
  await next(); expect(post).toHaveBeenCalledTimes(2); expect(onSave).toHaveBeenCalledTimes(1);
  await next(); expect(onSave.mock.calls[1][0]).toEqual({...unknown, capturedAt:expect.any(String), taskId:'lab', source:'automatic'});
  await next(); expect(onSave).toHaveBeenCalledTimes(2); expect(screen.getByRole('alert')).toHaveTextContent('模型结果无法读取');
  await click('停止采样');
  expect(option).not.toBeChecked();
  await click('每分钟采样');
  expect(post.mock.calls.at(-1) && JSON.parse(post.mock.calls.at(-1)![1].body).automatic).toBeUndefined();
  expect(screen.getByLabelText('工作摘要')).toBeInTheDocument();
  expect(onSave).toHaveBeenCalledTimes(2);
});

test('an automatic save retries using its original timestamp and drops inference arriving after Stop', async () => {
  vi.useFakeTimers();
  camera();
  vi.stubGlobal('crypto', { subtle: undefined });
  let finish!: (value: Response) => void;
  const post = vi.fn().mockImplementationOnce(async()=>Response.json(result))
    .mockImplementationOnce(()=>new Promise(resolve=>{finish = resolve;}));
  vi.stubGlobal('fetch', post);
  const onSave = vi.fn().mockRejectedValueOnce(new Error('回复中断')).mockResolvedValue(undefined);
  render(<ScreenObservation tasks={tasks} onSave={onSave}/>);
  fireEvent.change(screen.getByLabelText('关联任务'), {target:{value:'lab'}});
  fireEvent.click(screen.getByLabelText('周期采样时自动记录'));
  await click('每分钟采样');
  expect(screen.getByRole('alert')).toHaveTextContent('回复中断');
  await act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
  expect(onSave.mock.calls[1][0]).toEqual(onSave.mock.calls[0][0]);
  await click('停止采样');
  expect(onSave.mock.calls[1][1].aborted).toBe(true);
  await act(async()=>{finish(Response.json({...result,summary:'随后才到达的模型结果'}));});
  expect(onSave).toHaveBeenCalledTimes(2);
});

test('preserves an editable reading location separately from completed parts', async () => {
  camera();
  const observed = {summary:'正在阅读论文。',nextStep:'',progress:null,completedParts:[],
    readingSection:'Introduction',readingDocument:'Lab Report'};
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>Response.json(observed)));
  const onSave = vi.fn();
  render(<ScreenObservation tasks={tasks} onSave={onSave}/>);
  fireEvent.change(screen.getByLabelText('关联任务'), {target:{value:'lab'}});
  await click('截取一次');
  expect(screen.getByLabelText(/阅读书签/)).toHaveValue('Introduction');
  expect(screen.getByLabelText(/文档标题/)).toHaveValue('Lab Report');
  fireEvent.change(screen.getByLabelText(/文档标题/),{target:{value:'Reviewed Paper Title'}});
  fireEvent.change(screen.getByLabelText(/阅读书签/),{target:{value:'Methods'}});
  expect(screen.getByLabelText(/已完成的具体部分/)).toHaveValue('');
  await click('确认并保存');
  expect(onSave.mock.calls[0][0]).toMatchObject({source:'manual',readingSection:'Methods',readingDocument:'Reviewed Paper Title',completedParts:[],progress:null});
  expect(onSave.mock.calls[0][0].readingConfirmed).toBeUndefined();
  await click('截取一次');
  fireEvent.change(screen.getByLabelText(/阅读书签/),{target:{value:''}});
  await click('确认并保存');
  expect(onSave.mock.calls[1][0].readingSection).toBeUndefined();
  expect(onSave.mock.calls[1][0].readingDocument).toBeUndefined();
});

test('autosaving a section transition keeps a bookmark even when the model summary repeats', async () => {
  vi.useFakeTimers();
  camera();
  vi.stubGlobal('crypto',{subtle:undefined});
  const observed = {summary:'正在阅读同一篇论文。',nextStep:'',progress:null,completedParts:[],readingDocument:'Lab Report'};
  vi.stubGlobal('fetch',vi.fn().mockImplementationOnce(async()=>Response.json({...observed,readingSection:'Introduction'}))
    .mockImplementation(async()=>Response.json({...observed,readingSection:'Method'})));
  const onSave = vi.fn();
  render(<ScreenObservation tasks={tasks} onSave={onSave}/>);
  fireEvent.change(screen.getByLabelText('关联任务'), {target:{value:'lab'}});
  fireEvent.click(screen.getByLabelText('周期采样时自动记录'));
  await click('每分钟采样');
  await act(async()=>{await vi.advanceTimersByTimeAsync(120_000);});
  expect(onSave.mock.calls.map(call=>call[0].readingSection)).toEqual(['Introduction','Method']);
  expect(onSave.mock.calls.every(call=>call[0].source==='automatic' && !call[0].completedParts.length && !call[0].readingConfirmed)).toBe(true);
});

test('deduplicates reworded notes only when the captured evidence and screen remain alike', async () => {
  vi.useFakeTimers();
  const { drawImage } = camera();
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(24);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(12);
  vi.stubGlobal('crypto', {subtle: undefined});
  let shade = 40;
  const getImageData = () => ({data:Uint8ClampedArray.from({length:24*12*4}, (_,i) =>
    i%4===3 ? 255 : (Math.floor(i/4)%24 < 12 ? shade : 40))});
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({fillRect:vi.fn(), drawImage, getImageData} as unknown as CanvasRenderingContext2D);
  let note = result;
  vi.stubGlobal('fetch',async()=>Response.json(note));
  const onSave = vi.fn();
  render(<ScreenObservation tasks={tasks} onSave={onSave}/>);
  fireEvent.change(screen.getByLabelText('关联任务'),{target:{value:'lab'}});
  fireEvent.click(screen.getByLabelText('周期采样时自动记录'));
  await click('每分钟采样');
  const sample = () => act(async()=>{await vi.advanceTimersByTimeAsync(60_000);});
  note = {...result, summary:'相同进度，另一种模型措辞。'}; shade = 41;
  await sample(); expect(onSave).toHaveBeenCalledTimes(1);
  note = {...result, summary:'正文新增一段实验说明。'}; shade = 95;
  await sample(); expect(onSave).toHaveBeenCalledTimes(2);
  note = {...note, completedParts:['Introduction','Method','Results']};
  await sample(); expect(onSave).toHaveBeenCalledTimes(3);
  await click('停止采样');
});
