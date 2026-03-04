const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ASSETS = path.join(__dirname, '..', 'assets');

function resolveSourceIcon() {
  const candidates = [
    path.join(__dirname, '..', 'src', 'atlas.png'),
    path.join(__dirname, '..', 'assets', 'icon.svg'),
    path.join(__dirname, '..', 'assets', 'icon.png')
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function generateIco(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6 + count * 16;
  let dataOffset = headerSize;
  const entries = [];

  for (const buf of pngBuffers) {
    entries.push({ size: buf.length, offset: dataOffset });
    dataOffset += buf.length;
  }

  const ico = Buffer.alloc(dataOffset);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(count, 4);

  const sizes = [256, 128, 64, 48, 32, 16];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const s = sizes[i] || 0;
    ico.writeUInt8(s >= 256 ? 0 : s, off);
    ico.writeUInt8(s >= 256 ? 0 : s, off + 1);
    ico.writeUInt8(0, off + 2);
    ico.writeUInt8(0, off + 3);
    ico.writeUInt16LE(1, off + 4);
    ico.writeUInt16LE(32, off + 6);
    ico.writeUInt32LE(entries[i].size, off + 8);
    ico.writeUInt32LE(entries[i].offset, off + 12);
    pngBuffers[i].copy(ico, entries[i].offset);
  }
  return ico;
}

async function main() {
  if (!fs.existsSync(ASSETS)) fs.mkdirSync(ASSETS, { recursive: true });

  const srcIcon = resolveSourceIcon();
  if (!srcIcon) {
    console.error('Source icon not found. Checked assets/icon.svg, src/atlas.png, assets/icon.png');
    process.exit(1);
  }
  console.log('[icon] Source:', srcIcon);

  const sizes = [256, 128, 64, 48, 32, 16];
  const pngBuffers = [];
  for (const s of sizes) {
    const png = await sharp(srcIcon)
      .resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    pngBuffers.push(png);
  }

  fs.writeFileSync(path.join(ASSETS, 'icon.png'), pngBuffers[0]);
  console.log('[icon] Wrote assets/icon.png (256x256)');

  const icoBuffer = await generateIco(pngBuffers);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), icoBuffer);
  console.log('[icon] Wrote assets/icon.ico');
  console.log('[icon] Done!');
}

main().catch(err => { console.error(err); process.exit(1); });
