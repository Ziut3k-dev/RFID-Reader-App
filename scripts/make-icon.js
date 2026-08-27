/**
 * Rasteryzuje build/icon.svg do build/icon.png (1024×1024 z kanałem alfa).
 *
 * Rysowanie robi Chromium wbudowany w Electrona, więc nie trzeba instalować
 * ImageMagick ani librsvg. Z jednego pliku PNG electron-builder wytwarza .icns
 * dla macOS, .ico dla Windows i zestaw rozmiarów dla Linuksa.
 *
 * Rysujemy do elementu canvas i pobieramy dataURL, a nie zrzut ekranu okna:
 * przezroczystość zrzutu zależy od kompozycji okna i od wersji Electrona
 * (w wersji 43 okno `transparent: true` zwraca już czarne tło), natomiast canvas
 * zachowuje alfę zawsze. Narożniki ikony muszą być przezroczyste, bo inaczej
 * macOS pokaże kwadrat z czarnym tłem zamiast zaokrąglonego symbolu.
 *
 * Uruchomienie: npm run icon
 */

import { app, BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const svgPath = path.join(dir, '..', 'build', 'icon.svg');
const pngPath = path.join(dir, '..', 'build', 'icon.png');
const SIZE = 1024;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svgBase64 = fs.readFileSync(svgPath).toString('base64');

  const win = new BrowserWindow({ show: false, width: 16, height: 16 });
  await win.loadURL('data:text/html;charset=utf-8,<!doctype html><meta charset="utf-8">');

  const dataUrl = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = ${SIZE};
        canvas.height = ${SIZE};
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, ${SIZE}, ${SIZE});
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('nie udało się wczytać SVG'));
      img.src = 'data:image/svg+xml;base64,${svgBase64}';
    })
  `);

  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(pngPath, png);

  // Kontrola: narożnik musi być w pełni przezroczysty, a środek nieprzezroczysty.
  const bitmap = nativeImage.createFromBuffer(png).toBitmap(); // BGRA
  const alphaAt = (x, y) => bitmap[(y * SIZE + x) * 4 + 3];
  const corner = alphaAt(4, 4);
  const center = alphaAt(SIZE / 2, SIZE / 2);
  console.log(
    `Zapisano ${path.relative(process.cwd(), pngPath)} — ${SIZE}×${SIZE}, ` +
    `${(png.length / 1024).toFixed(0)} kB, alfa narożnika ${corner}, alfa środka ${center}`,
  );

  win.destroy();
  if (corner !== 0 || center !== 255) {
    console.error('BŁĄD: ikona nie ma poprawnej przezroczystości.');
    app.exit(1);
    return;
  }
  app.quit();
});
