/** A session keeps coarse block averages in memory to compare slight video conversion differences. */
export interface FrameAppearance {
  width: number;
  height: number;
  colors: Uint8Array;
}

export function frameAppearance(canvas: HTMLCanvasElement): FrameAppearance | undefined {
  const ctx = canvas.getContext('2d');
  if (!ctx?.getImageData) return undefined;
  const { width, height } = canvas;
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const block = 12;
  const colors = new Uint8Array(Math.ceil(width / block) * Math.ceil(height / block) * 3);
  let position = 0;
  for (let y = 0; y < height; y += block) {
    const bottom = Math.min(y + block, height);
    for (let x = 0; x < width; x += block) {
      const right = Math.min(x + block, width);
      let red = 0, green = 0, blue = 0;
      for (let yy = y; yy < bottom; yy++) {
        const end = (yy * width + right) * 4;
        for (let i = (yy * width + x) * 4; i < end; i += 4) {
          red += rgba[i]; green += rgba[i + 1]; blue += rgba[i + 2];
        }
      }
      const count = (right - x) * (bottom - y);
      colors[position++] = Math.round(red / count);
      colors[position++] = Math.round(green / count);
      colors[position++] = Math.round(blue / count);
    }
  }
  return { width, height, colors };
}

export function sameAppearance(a?: FrameAppearance, b?: FrameAppearance): boolean {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return false;
  let difference = 0;
  for (let i = 0; i < a.colors.length; i++) {
    const delta = Math.abs(a.colors[i] - b.colors[i]);
    // Check each block too, since a changed line may occupy little of the whole screen.
    if (delta > 14) return false;
    difference += delta;
  }
  return difference <= a.colors.length;
}
