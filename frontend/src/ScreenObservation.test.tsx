import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import ScreenObservation from './ScreenObservation';

const result = { summary: '已完成引言和方法。', nextStep: '写讨论。', progress: { percent: 75, evidence: '3/4 completed' },
  completedParts: ['Introduction', 'Method'] };
const tasks = [{ id: 'lab', title: 'Lab Report' }];
const chooseImage = async (file = new File(['fixture'], 'work.png', { type: 'image/png' })) => {
  await act(async () => { fireEvent.change(screen.getByLabelText('选择截图文件'), { target: { files: [file] } }); });
};
function imageFixture() {
  const revoke = vi.fn();
  class LocalURL extends URL { static createObjectURL = () => 'blob:fixture'; static revokeObjectURL = revoke; }
  vi.stubGlobal('URL', LocalURL);
  vi.stubGlobal('Image', class { naturalWidth = 3000; naturalHeight = 1500; src = ''; async decode() {} });
  const drawImage = vi.fn();
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({ fillRect: vi.fn(), drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,pixels');
  return { revoke, drawImage };
}
const click = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole('button', { name })); }); };
afterEach(() => vi.unstubAllGlobals());

test('optional upload resizes the image and saves only reviewed text with the chosen task and evidence', async () => {
  const { revoke, drawImage } = imageFixture();
  const post = vi.fn(async () => Response.json(result));
  vi.stubGlobal('fetch', post);
  const onSave = vi.fn();
  render(<ScreenObservation tasks={tasks} onSave={onSave} />);
  fireEvent.change(screen.getByLabelText(/关联任务/), { target: { value: 'lab' } });
  await chooseImage();
  expect(drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 1440, 720]);
  expect(revoke).toHaveBeenCalledWith('blob:fixture');
  expect(post).toHaveBeenCalledWith('/api/v1/screen-observation', expect.objectContaining({
    body: JSON.stringify({ image: 'data:image/jpeg;base64,pixels', taskId: 'lab' }),
  }));
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('工作摘要'), { target: { value: '本人核对的摘要' } });
  fireEvent.change(screen.getByLabelText(/已完成的具体部分/), { target: { value: 'Method\nResults' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /保存画面/ }));
  await click('确认并保存');
  expect(onSave).toHaveBeenCalledWith({ source: 'manual', capturedAt: expect.any(String), taskId: 'lab', summary: '本人核对的摘要',
    nextStep: result.nextStep, progress: null, completedParts: ['Method', 'Results'] });
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

test('a manual note may be unassigned or discarded, and invalid files never reach the model', async () => {
  imageFixture();
  const post = vi.fn(async () => Response.json({ ...result, progress: null, completedParts: [] }));
  vi.stubGlobal('fetch', post);
  const onSave = vi.fn();
  render(<ScreenObservation tasks={[]} onSave={onSave} />);
  await chooseImage(new File(['test'], 'note.txt', { type: 'text/plain' }));
  expect(screen.getByRole('alert')).toHaveTextContent('PNG 或 JPEG');
  expect(post).not.toHaveBeenCalled();
  await chooseImage();
  await click('放弃草稿');
  expect(onSave).not.toHaveBeenCalled();
  await chooseImage();
  await click('确认并保存');
  expect(onSave.mock.calls[0][0]).toMatchObject({ source: 'manual', taskId: null, progress: null });
});

test('preserves editable reading bookmarks separately from completed parts', async () => {
  imageFixture();
  const observed = { summary: '正在阅读论文。', nextStep: '', progress: null, completedParts: [], readingSection: 'Introduction', readingDocument: 'Lab Report' };
  vi.stubGlobal('fetch', async () => Response.json(observed));
  const onSave = vi.fn();
  render(<ScreenObservation tasks={tasks} onSave={onSave} />);
  fireEvent.change(screen.getByLabelText(/关联任务/), { target: { value: 'lab' } });
  await chooseImage();
  fireEvent.change(screen.getByLabelText(/文档标题/), { target: { value: 'Reviewed Paper Title' } });
  fireEvent.change(screen.getByLabelText(/阅读书签/), { target: { value: 'Methods' } });
  await click('确认并保存');
  expect(onSave.mock.calls[0][0]).toMatchObject({ readingSection: 'Methods', readingDocument: 'Reviewed Paper Title', completedParts: [], progress: null });
  expect(onSave.mock.calls[0][0].readingConfirmed).toBeUndefined();
  await chooseImage();
  fireEvent.change(screen.getByLabelText(/阅读书签/), { target: { value: '' } });
  await click('确认并保存');
  expect(onSave.mock.calls[1][0].readingSection).toBeUndefined();
  expect(onSave.mock.calls[1][0].readingDocument).toBeUndefined();
});
