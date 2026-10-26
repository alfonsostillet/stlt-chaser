// Renders build/icon.svg to build/icon.png (1024 px), which electron-builder turns into
// the Windows .ico and macOS .icns:  npx electron tools/render-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = path.join(__dirname, '..', 'build', 'icon.svg');
const png = path.join(__dirname, '..', 'build', 'icon.png');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
  const html = `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${fs.readFileSync(svg, 'utf8')}`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(png, image.resize({ width: 1024, height: 1024 }).toPNG());
  console.log(`wrote ${png}`);
  app.quit();
});
