// Drives the running editor over the Chrome DevTools Protocol for manual checks:
//   node tools/cdp.mjs screenshot out.png
//   node tools/cdp.mjs eval "document.title"
// Start the editor with: electron . --remote-debugging-port=9333
import { writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT ?? 9333;
const [command, arg] = process.argv.slice(2);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve));

let nextId = 1;
const pending = new Map();
const logs = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method === 'Runtime.exceptionThrown') {
    logs.push(`EXCEPTION ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
  } else if (message.method === 'Runtime.consoleAPICalled') {
    logs.push(`${message.params.type}: ${message.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

await send('Runtime.enable');
if (command === 'screenshot') {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(arg, Buffer.from(result.result.data, 'base64'));
  console.log(`saved ${arg}`);
} else if (command === 'eval') {
  const result = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(result.result.result?.value ?? result.result, null, 2));
} else if (command === 'mouse') {
  // arg: JSON list of [type, x, y, modifiers?], e.g. [["mousePressed",100,100],["mouseReleased",100,100]]
  for (const [type, x, y, modifiers = 0] of JSON.parse(arg)) {
    await send('Input.dispatchMouseEvent', { type, x, y, modifiers, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 30));
  }
} else if (command === 'key') {
  // arg: JSON list of [key, code, modifiers?]
  for (const [key, code, modifiers = 0] of JSON.parse(arg)) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
  }
} else if (command === 'front') {
  await send('Page.bringToFront');
} else if (command === 'reload') {
  await send('Page.reload');
  await new Promise((r) => setTimeout(r, 1500));
}
await new Promise((r) => setTimeout(r, 300));
if (logs.length) console.log(logs.join('\n'));
socket.close();
