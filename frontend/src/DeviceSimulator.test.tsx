import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISPLAY_PALETTE, rasterizeDisplaySnapshot, type DisplaySnapshot } from '../../contracts/display-snapshot';
import DeviceSimulator from './DeviceSimulator';

const first: DisplaySnapshot = { schema_version: 'display-1', layout_version: 'goal-1', revision: 'first', width: 400, height: 300,
  commands: [[0, 0, 0, 5, 5, 2], [1, 20, 60, 10, 0, 'First task']] };
const second: DisplaySnapshot = { ...first, revision: 'second', commands: [[1, 20, 60, 10, 0, 'Second task']] };
let putImageData: ReturnType<typeof vi.fn>;
const advance = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T09:00:00Z'));
  putImageData = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    putImageData,
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => vi.useRealTimers());

describe('device simulator screen', () => {
  it('paints the exact shared raster once, then skips unchanged revisions', async () => {
    const read = vi.fn().mockResolvedValue(first);
    render(<DeviceSimulator readSnapshot={read} />); await advance();
    expect(screen.getByRole('img', { name: /设备指令模拟屏/ })).toHaveAttribute('data-displayed-revision', 'first');
    const pixels = rasterizeDisplaySnapshot(first);
    const rgba = putImageData.mock.calls[0][0].data as Uint8ClampedArray;
    expect(rgba).toEqual(Uint8ClampedArray.from([...pixels].flatMap(pixel => [...DISPLAY_PALETTE[pixel], 255])));
    await advance(1000);
    expect(read).toHaveBeenCalledTimes(2); expect(putImageData).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('版本未变');
  });

  it('retains the last painted version when the next read fails', async () => {
    const read = vi.fn().mockResolvedValueOnce(first).mockRejectedValue(new Error('显示数据未通过设备校验'));
    render(<DeviceSimulator readSnapshot={read} />); await advance(); await advance(1000);
    expect(screen.getByRole('alert')).toHaveTextContent('保留上次已绘制画面');
    expect(screen.getByRole('img', { name: /设备指令模拟屏/ })).toHaveAttribute('data-displayed-revision', 'first');
    expect(putImageData).toHaveBeenCalledTimes(1);
    expect(document.getElementById('simulator-transcript')).toHaveTextContent('First task');
  });

  it('shows a waiting version and respects device refresh protection, including manual reads', async () => {
    const read = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
    render(<DeviceSimulator readSnapshot={read} />); await advance();
    fireEvent.click(screen.getByRole('button', { name: '设备节奏' })); await advance();
    expect(screen.getByRole('status')).toHaveTextContent('等待刷新');
    expect(screen.getByText('second', { selector: 'code' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '立即读取' })); await advance();
    expect(putImageData).toHaveBeenCalledTimes(1);
    await advance(30_000); expect(putImageData).toHaveBeenCalledTimes(1);
    await advance(30_000); expect(putImageData).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('img', { name: /设备指令模拟屏/ })).toHaveAttribute('data-displayed-revision', 'second');
  });

  it('pauses requests when disconnected and fetches the latest frame on reconnect', async () => {
    const read = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second);
    render(<DeviceSimulator readSnapshot={read} />); await advance();
    fireEvent.click(screen.getByRole('button', { name: '模拟断网' }));
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '立即读取' })).toBeDisabled();
    expect(screen.getByRole('img', { name: /设备指令模拟屏/ })).toHaveAttribute('data-displayed-revision', 'first');
    fireEvent.click(screen.getByRole('button', { name: '恢复网络' })); await advance();
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('img', { name: /设备指令模拟屏/ })).toHaveAttribute('data-displayed-revision', 'second');
  });

  it('ignores a response arriving after simulated disconnection', async () => {
    let resolve!: (snapshot: DisplaySnapshot) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<DisplaySnapshot>(done => { resolve = done; })).mockResolvedValue(second);
    render(<DeviceSimulator readSnapshot={read} />); await advance();
    fireEvent.click(screen.getByRole('button', { name: '模拟断网' }));
    await act(async () => { resolve(first); });
    expect(putImageData).not.toHaveBeenCalled();
    expect(read.mock.calls[0][0].aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '恢复网络' })); await advance();
    expect(putImageData).toHaveBeenCalledTimes(1);
  });

  it('scales only CSS and exports the original 400 by 300 PNG', async () => {
    const png = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,test');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<DeviceSimulator readSnapshot={vi.fn().mockResolvedValue(first)} />); await advance();
    fireEvent.click(screen.getByRole('button', { name: '2×' }));
    const canvas = screen.getByRole('img', { name: /设备指令模拟屏/ });
    expect(canvas).toHaveAttribute('width', '400'); expect(canvas).toHaveAttribute('height', '300');
    expect(canvas).toHaveStyle({ width: '800px', height: '600px' });
    fireEvent.click(screen.getByRole('button', { name: '导出 PNG' }));
    expect(png).toHaveBeenCalledWith('image/png'); expect(click).toHaveBeenCalledOnce();
    expect(screen.getByText(/不是电子纸真机的在线状态或同步回执/)).toBeVisible();
  });
});
