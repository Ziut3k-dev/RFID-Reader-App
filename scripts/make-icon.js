/**
 * Rasteryzuje build/icon.svg do build/icon.png (1024×1024, z kanałem alfa).
 *
 * Rysowanie robi Chromium wbudowany w Electrona, więc nie trzeba instalować
 * ImageMagick, librsvg ani innych narzędzi zewnętrznych. Z jednego pliku PNG
 * electron-builder wytwarza .icns dla macOS, .ico dla Windows i zestaw
 * rozmiarów dla Linuksa.
 *
 * Uruchomienie: npm run icon
 */

import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const svgPath = path.join(dir, '..', 'build', 'icon.svg');
const pngPath = path.join(dir, '..', 'build', 'icon.png');
const SIZE = 1024;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svg = fs.readFileSync(svgPath, 'utf8');
  const page = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;width:${SIZE}px;height:${SIZE}px}</style>${svg}`;

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    transparent: true,
    frame: false,
    // Zrzut ma mieć dokładnie 1024 px niezależnie od skalowania ekranu.
    useContentSize: true,
    webPreferences: { offscreen: true, deviceScaleFactor: 1 },
  });

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const png = image.resize({ width: SIZE, height: SIZE }).toPNG();

  fs.writeFileSync(pngPath, png);
  console.log(`Zapisano ${path.relative(process.cwd(), pngPath)} — ${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(0)} kB`);

  win.destroy();
  app.quit();
});
