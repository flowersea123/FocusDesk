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
  fireEvent.click(screen.getByRole('checkbox'));
  await click('确认并保存');
  expect(onSave).toHaveBeenCalledWith({capturedAt:expect.any(String),taskId:'lab',summary:'本人核对的摘要',
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
