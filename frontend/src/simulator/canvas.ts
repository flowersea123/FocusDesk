import { DISPLAY_PALETTE, rasterizeDisplaySnapshot, type DisplaySnapshot } from '../../../contracts/display-snapshot';

export function paintDisplaySnapshot(canvas: HTMLCanvasElement, snapshot: DisplaySnapshot): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法绘制模拟屏。');
  const pixels = rasterizeDisplaySnapshot(snapshot);
  const image = context.createImageData(400, 300);
  for (let index = 0; index < pixels.length; index++) {
    const [red, green, blue] = DISPLAY_PALETTE[pixels[index]];
    image.data.set([red, green, blue, 255], index * 4);
  }
  // Assemble and validate before the single visible write; failures keep the old canvas.
  context.putImageData(image, 0, 0);
}
