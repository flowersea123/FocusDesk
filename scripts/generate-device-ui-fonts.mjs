import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cache = path.join(root, '.cache/device-ui-font-tools');
const freeType = path.join(root, '.cache/source-font-tools/freetype-2.13.3');
const compiler = process.env.FOCUSDESK_FONT_COMPILER ?? 'C:/Program Files/mingw64/bin/gcc.exe';
const nunitoCommit = '8c6a9bb9732545b9ed53f29ec5e1ab0ff53c4e6f';
const notoCommit = 'a85815a42757630ce188fdad368c2dfc444d4773';
const inputs = [
  { file: 'Nunito.ttf', local: 'frontend/public/fonts/Nunito.ttf', hash: 'bb55a5ca5c2042335b3991af27c4d0705d0ef41cac6164ac737fd8f2a1e85207', url: `https://raw.githubusercontent.com/googlefonts/nunito/${nunitoCommit}/fonts/variable/Nunito%5Bwght%5D.ttf` },
  { file: 'Nunito-LICENSE.txt', local: 'frontend/public/fonts/Nunito-LICENSE.txt', hash: '580df76c95a1ec5ab878ceb25bb3d85c6a076804e9c970c8c6972aea775fdf65', url: `https://raw.githubusercontent.com/googlefonts/nunito/${nunitoCommit}/OFL.txt` },
  { file: 'NotoSansSC.ttf', hash: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da', url: `https://raw.githubusercontent.com/google/fonts/${notoCommit}/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf` },
  { file: 'NotoSansSC-LICENSE.txt', hash: '1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9', url: `https://raw.githubusercontent.com/google/fonts/${notoCommit}/ofl/notosanssc/OFL.txt` },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(cache, { recursive: true });
for (const input of inputs) {
  const filename = path.join(cache, input.file);
  let bytes;
  try { bytes = await readFile(filename); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (input.local) bytes = await readFile(path.join(root, input.local));
    else {
      const response = await fetch(input.url);
      if (!response.ok) throw new Error(`Font download failed with HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
  }
  if (hash(bytes) !== input.hash) throw new Error(`Font input hash mismatch: ${input.file}`);
  await writeFile(filename, bytes);
}
const archive = await readFile(path.join(root, '.cache/source-font-tools/freetype-2.13.3.tar.xz'));
if (hash(archive) !== '0550350666d427c74daeb85d5ac7bb353acba5f76956395995311a9c6f063289') throw new Error('FreeType archive hash mismatch');

// Native FreeType exports true pixel-sized monochrome glyphs, including variable weights.
const converterSource = String.raw`#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_MULTIPLE_MASTERS_H

static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void base64(const uint8_t* bytes, size_t length) {
  for (size_t i = 0; i < length; i += 3) {
    const uint32_t value = ((uint32_t)bytes[i] << 16) |
      (i + 1 < length ? (uint32_t)bytes[i + 1] << 8 : 0) |
      (i + 2 < length ? bytes[i + 2] : 0);
    putchar(alphabet[(value >> 18) & 63]); putchar(alphabet[(value >> 12) & 63]);
    putchar(i + 1 < length ? alphabet[(value >> 6) & 63] : '=');
    putchar(i + 2 < length ? alphabet[value & 63] : '=');
  }
}

static int glyph(FT_Face face, FT_UInt index) {
  if (FT_Load_Glyph(face, index, FT_LOAD_DEFAULT | FT_LOAD_TARGET_MONO) ||
      FT_Render_Glyph(face->glyph, FT_RENDER_MODE_MONO)) return 0;
  const FT_Bitmap* image = &face->glyph->bitmap;
  const size_t bits = (size_t)image->width * image->rows;
  const size_t bytes = (bits + 7) / 8;
  uint8_t* packed = calloc(bytes ? bytes : 1, 1);
  if (!packed) return 0;
  for (unsigned y = 0; y < image->rows; ++y) {
    const unsigned row = image->pitch < 0 ? image->rows - 1 - y : y;
    const uint8_t* input = image->buffer + row * (unsigned)abs(image->pitch);
    for (unsigned x = 0; x < image->width; ++x) {
      const size_t bit = (size_t)y * image->width + x;
      if (input[x / 8] & (0x80 >> (x % 8))) packed[bit / 8] |= 0x80 >> (bit % 8);
    }
  }
  printf("[%u,%u,%ld,%d,%d,\"", image->width, image->rows,
    face->glyph->advance.x / 64, face->glyph->bitmap_left, -face->glyph->bitmap_top);
  base64(packed, bytes); printf("\"]"); free(packed); return 1;
}

int main(int argc, char** argv) {
  if (argc != 5) { fprintf(stderr, "Usage: glyphdump font pixels weight ascii|unicode\n"); return 2; }
  FT_Library library; FT_Face face; FT_MM_Var* axes = NULL;
  const int pixels = atoi(argv[2]), weight = atoi(argv[3]);
  if (FT_Init_FreeType(&library) || FT_New_Face(library, argv[1], 0, &face)) return 3;
  if (FT_Get_MM_Var(face, &axes)) return 4;
  FT_Fixed* coords = calloc(axes->num_axis, sizeof(FT_Fixed));
  if (!coords) return 5;
  int weightFound = 0;
  for (FT_UInt i = 0; i < axes->num_axis; ++i) {
    coords[i] = axes->axis[i].def;
    if (axes->axis[i].tag == FT_MAKE_TAG('w','g','h','t')) { coords[i] = weight * 65536L; weightFound = 1; }
  }
  if (!weightFound || FT_Set_Var_Design_Coordinates(face, axes->num_axis, coords) ||
      FT_Set_Pixel_Sizes(face, 0, pixels) || FT_Select_Charmap(face, FT_ENCODING_UNICODE)) return 6;
  free(coords); FT_Done_MM_Var(library, axes);
  printf("{\"pixels\":%d,\"weight\":%d,\"lineHeight\":%ld,\"missing\":", pixels, weight, face->size->metrics.height / 64);
  if (!glyph(face, 0)) return 7;
  printf(",\"glyphs\":{");
  int first = 1;
  if (strcmp(argv[4], "ascii") == 0) {
    for (FT_ULong code = 32; code <= 126; ++code) {
      const FT_UInt index = FT_Get_Char_Index(face, code);
      if (!index) return 8;
      printf("%s\"%lu\":", first ? "" : ",", code); first = 0;
      if (!glyph(face, index)) return 9;
    }
  } else {
    FT_UInt index;
    FT_ULong code = FT_Get_First_Char(face, &index);
    while (index) {
      if (code > 126) {
        printf("%s\"%lu\":", first ? "" : ",", code); first = 0;
        if (!glyph(face, index)) return 10;
      }
      code = FT_Get_Next_Char(face, code, &index);
    }
  }
  printf("}}\n"); FT_Done_Face(face); FT_Done_FreeType(library); return 0;
}
`;
const converterC = path.join(cache, 'glyphdump.c');
const converter = path.join(cache, 'glyphdump.exe');
await writeFile(converterC, converterSource);
const components = ['base/ftsystem.c', 'base/ftinit.c', 'base/ftdebug.c', 'base/ftbase.c', 'base/ftbbox.c', 'base/ftglyph.c', 'base/ftbitmap.c', 'base/ftmm.c', 'autofit/autofit.c', 'truetype/truetype.c', 'sfnt/sfnt.c', 'psnames/psnames.c', 'raster/raster.c', 'smooth/smooth.c', 'gzip/ftgzip.c', 'lzw/ftlzw.c'];
try {
  const output = execFileSync(compiler, ['-std=c99', '-O2', '-DFT2_BUILD_LIBRARY', '-I', path.join(freeType, 'include'), converterC, ...components.map(file => path.join(freeType, 'src', file)), '-o', converter, '-lm'], { windowsHide: true, timeout: 120000, encoding: 'utf8' });
  await writeFile(path.join(cache, 'compile.log'), output);
} catch (error) {
  await writeFile(path.join(cache, 'compile.log'), `${error.stdout ?? ''}${error.stderr ?? ''}`);
  throw error;
}

const profiles = [
  ['NunitoRegular10px', 10, 400], ['NunitoBold10px', 10, 750],
  ['NunitoRegular11px', 11, 400], ['NunitoBold11px', 11, 750],
  ['NunitoRegular13px', 13, 400], ['NunitoRegular16px', 16, 400],
  ['NunitoBold16px', 16, 750], ['NunitoBold17px', 17, 700],
];
const destination = path.join(root, 'firmware/focusdesk_device/fonts');
const artifacts = [];
for (const [name, pixels, weight] of profiles) {
  const result = JSON.parse(execFileSync(converter, [path.join(cache, 'Nunito.ttf'), String(pixels), String(weight), 'ascii'], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
  const bitmap = [], metrics = [];
  for (let code = 32; code <= 126; code++) {
    const [width, height, advance, xOffset, yOffset, base64] = result.glyphs[code];
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length !== Math.ceil(width * height / 8) || width > 255 || height > 255 || advance > 255 || xOffset < -128 || xOffset > 127 || yOffset < -128 || yOffset > 127) throw new Error(`Invalid GFX metrics: ${name} U+${code.toString(16)}`);
    metrics.push([bitmap.length, width, height, advance, xOffset, yOffset]);
    bitmap.push(...bytes);
  }
  if (bitmap.length > 65535) throw new Error(`GFX bitmap exceeds offset limit: ${name}`);
  const rows = [];
  for (let i = 0; i < bitmap.length; i += 16) rows.push('  ' + bitmap.slice(i, i + 16).map(byte => `0x${byte.toString(16).padStart(2, '0')}`).join(', '));
  const header = `// SPDX-License-Identifier: OFL-1.1\n// Copyright 2014 The Nunito Project Authors.\n// Source ${nunitoCommit}, TTF SHA-256 ${inputs[0].hash}.\n// Generated with FreeType 2.13.3, FT_Set_Pixel_Sizes ${pixels}px, wght=${weight}, monochrome.\n// Full notice and license in Nunito-LICENSE.txt.\n#pragma once\n#include <Arduino.h>\n#include <gfxfont.h>\n\nconst uint8_t ${name}Bitmaps[] PROGMEM = {\n${rows.join(',\n')}\n};\n\nconst GFXglyph ${name}Glyphs[] PROGMEM = {\n${metrics.map(glyph => `  { ${glyph.join(', ')} }`).join(',\n')}\n};\n\nconst GFXfont ${name} PROGMEM = {\n  (uint8_t*)${name}Bitmaps, (GFXglyph*)${name}Glyphs, 0x20, 0x7e, ${result.lineHeight}\n};\n`;
  const filename = path.join(destination, `${name}.h`);
  await writeFile(filename, header);
  await writeFile(path.join(cache, `${name}.json`), JSON.stringify(result));
  artifacts.push({ name, pixels, weight, glyphs: metrics.length, bitmapBytes: bitmap.length, headerBytes: Buffer.byteLength(header), sha256: hash(header) });
}
await writeFile(path.join(destination, 'Nunito-LICENSE.txt'), await readFile(path.join(cache, 'Nunito-LICENSE.txt')));

const cjk = JSON.parse(execFileSync(converter, [path.join(cache, 'NotoSansSC.ttf'), '13', '400', 'unicode'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }));
for (const [code, glyph] of Object.entries(cjk.glyphs)) {
  if (Buffer.from(glyph[5], 'base64').length !== Math.ceil(glyph[0] * glyph[1] / 8)) throw new Error(`Invalid CJK bitmap ${code}`);
}
const table = { name: 'Noto Sans SC', pixelSize: 13, glyphs: cjk.glyphs, missing: cjk.missing };
const tableSource = `// SPDX-License-Identifier: OFL-1.1\n// Noto Sans SC, Google Fonts commit ${notoCommit}.\n// TTF SHA-256 ${inputs[2].hash}.\n// FreeType 2.13.3, 13px, wght=400, monochrome. Hub-side resources.\n// Full notices and licenses in DISPLAY_FONT_LICENSE.txt.\nexport type CJKGlyph = [number, number, number, number, number, string];\nexport const DISPLAY_CJK_FONT: { name: string; pixelSize: number; glyphs: Record<string, CJKGlyph>; missing: CJKGlyph } = ${JSON.stringify(table)};\n`;
await writeFile(path.join(root, 'contracts/display-cjk-font.ts'), tableSource);
const noticesFile = path.join(root, 'contracts/DISPLAY_FONT_LICENSE.txt');
const marker = '\n\nNunito and Noto Sans SC device UI fonts (2026-11-12)\n';
let notices = await readFile(noticesFile, 'utf8');
const previous = notices.indexOf(marker);
if (previous >= 0) notices = notices.slice(0, previous);
await writeFile(noticesFile, notices + marker + inputs.map(input => `${input.file}\n${input.url}\nSHA-256 ${input.hash}`).join('\n\n') + '\n\nNunito license\n\n' + await readFile(path.join(cache, 'Nunito-LICENSE.txt'), 'utf8') + '\n\nNoto Sans SC license\n\n' + await readFile(path.join(cache, 'NotoSansSC-LICENSE.txt'), 'utf8'));
const manifest = { freetypeVersion: '2.13.3', freetypeArchiveSha256: hash(archive), converterSourceSha256: hash(converterSource), converterSha256: hash(await readFile(converter)), ftmoduleSha256: hash(await readFile(path.join(freeType, 'include/freetype/config/ftmodule.h'))), inputs, artifacts, cjk: { name: table.name, pixels: 13, weight: 400, glyphs: Object.keys(cjk.glyphs).length, sourceBytes: Buffer.byteLength(tableSource), sha256: hash(tableSource) } };
await writeFile(path.join(cache, 'build-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Generated ${artifacts.length} Nunito fonts and ${manifest.cjk.glyphs} non-ASCII Noto Sans SC glyphs.`);
console.log(`Manifest: ${path.join(cache, 'build-manifest.json')}`);
