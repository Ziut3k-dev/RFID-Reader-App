import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jsQR from 'jsqr';

/**
 * Kod QR z panelu parowania musi dać się odczytać telefonem. Sprawdzamy to
 * przejściem w obie strony: matrycę z generatora (tego samego, który rysuje kod
 * w aplikacji) podajemy dekoderowi jsQR — temu samemu, którego używa strona
 * skanera na telefonie.
 */
function decodeMatrix(qr, scale = 4, quiet = 4) {
  const size = qr.modules.size;
  const data = qr.modules.data;
  const side = (size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(side * side * 4).fill(255);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!data[y * size + x]) continue;          // jasny moduł — tło już jest białe
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const px = ((y + quiet) * scale + dy) * side + ((x + quiet) * scale + dx);
          rgba[px * 4] = 0;
          rgba[px * 4 + 1] = 0;
          rgba[px * 4 + 2] = 0;
        }
      }
    }
  }
  return jsQR(rgba, side, side);
}

test('adres sparowania zakodowany w QR odczytuje się bez zmian', () => {
  const url = 'http://192.168.1.42:8787/s/9f2c1ab34d5e6f708192a3b4c5d6e7f8';
  const result = decodeMatrix(QRCode.create(url, { errorCorrectionLevel: 'M' }));

  assert.ok(result, 'dekoder nie znalazł kodu');
  assert.equal(result.data, url);
});

test('kod pozostaje czytelny dla długiego adresu IPv4 i portu', () => {
  const url = 'http://255.255.255.255:65535/s/' + 'a'.repeat(32);
  const result = decodeMatrix(QRCode.create(url, { errorCorrectionLevel: 'M' }));

  assert.ok(result, 'dekoder nie znalazł kodu');
  assert.equal(result.data, url);
});

test('kod odczytu karty dla systemowej kamery zawiera numer', () => {
  // Kod QR naklejony na kartę może wskazywać wprost na /q/<sekret>/<numer>,
  // wtedy aplikacja Kamera w iOS rejestruje odczyt bez otwierania skanera.
  const url = 'http://10.0.0.5:8787/q/' + 'b'.repeat(32) + '/0004372425';
  const result = decodeMatrix(QRCode.create(url, { errorCorrectionLevel: 'M' }));

  assert.ok(result);
  assert.equal(result.data, url);
  assert.match(result.data, /0004372425$/);
});
