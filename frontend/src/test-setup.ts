import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom has no canvas raster backend. Layout/pixels are tested through the
// shared rasterizer; this seam verifies that React paints those exact bytes.
if (typeof HTMLCanvasElement !== 'undefined') Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  value: vi.fn(() => ({
    createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: vi.fn(),
  })),
});

afterEach(cleanup);
