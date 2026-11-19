// VECTOR ATC for Windows: the game in its own window, connected to the game server.
// The server does the heavy work (pilot AI, voices, speech recognition); this app shows the game,
// gives it the microphone, and keeps running smoothly when it isn't the front window.
const { app, BrowserWindow, Menu, session, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
let autoUpdater = null; try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { } // absent when run from source without it

const SERVERS = {
  online: { label: 'Online (atc.moatsoftwares.com)', url: 'https://atc.moatsoftwares.com' },
  home: { label: 'Home network (192.168.1.177)', url: 'https://192.168.1.177:8443' },
  offline: { label: 'Offline (this computer)', url: 'http://127.0.0.1:0' }, // the port is filled in when it starts
};
/* ---------- offline ----------
   The game's own files travel inside the app (resources/game). Offline, the app serves them itself on this
   computer: no account, no internet. Pilots speak with the Windows voices, the weather is simulated, the
   map is the airport drawing, and you type or click your calls (speech recognition needs the game server). */
const http = require('http');
let offline = null;
function gameDir() { const a = path.join(process.resourcesPath || '', 'game'), b = path.join(__dirname, '..', 'public'); return fs.existsSync(a) ? a : b; }
function startOffline() {
  if (offline) return Promise.resolve(offline);
  const root = gameDir(), TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname);
    if (p === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ asr: false, brain: false, voice: false, mock: false, offline: true, problem: 'offline' })); }
    if (p.startsWith('/api/') || p.startsWith('/tiles/')) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"offline"}'); }
    if (p === '/') p = '/index.html';
    const f = path.normalize(path.join(root, p));
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(ok => srv.listen(0, '127.0.0.1', () => { offline = srv; SERVERS.offline.url = 'http://127.0.0.1:' + srv.address().port; console.log('VECTOR offline at ' + SERVERS.offline.url); ok(srv); }));
}
const cfgFile = () => path.join(app.getPath('userData'), 'settings.json');
let cfg = { server: 'online', bounds: { width: 1440, height: 900 } };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch (e) { }
const save = () => { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg)); } catch (e) { } };
if (process.argv.includes('--offline')) cfg.server = 'offline'; // a shortcut can start the app offline
// --server=<url> on the command line points the app at another server (testing, a new host)
const argServer = (process.argv.find(x => x.startsWith('--server=')) || '').slice(9);
const serverUrl = () => argServer || (SERVERS[cfg.server] || SERVERS.online).url;
const sameSite = u => { try { return new URL(u).origin === new URL(serverUrl()).origin; } catch (e) { return false; } };

if (!app.requestSingleInstanceLock()) app.quit();
app.commandLine.appendSwitch('disable-renderer-backgrounding'); // the radio and the sim keep going behind other windows
let win = null;

function failPage(reason) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html><html><head><title>VECTOR ATC</title><style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#0A0E13;color:#E7EBF0;font-family:system-ui,'Segoe UI',sans-serif}
  div{max-width:440px;padding:28px;border:1px solid #2D3846;border-radius:12px;background:#10151C}h1{margin:0 0 8px;font-size:22px}p{color:#8A95A3;line-height:1.5}
  button{height:42px;padding:0 20px;border:0;border-radius:8px;background:#2F7CF6;color:#fff;font-weight:700;font-size:15px;cursor:pointer}</style></head>
  <body><div><h1>Can’t reach the game server</h1><p>${reason}. Check your internet connection, or pick another server in the Server menu.</p>
  <button onclick="location.href='${serverUrl()}'">Try again</button></div></body></html>`);
}

function createWindow() {
  win = new BrowserWindow({
    ...cfg.bounds, minWidth: 1000, minHeight: 640, show: false, backgroundColor: '#0A0E13', title: 'VECTOR ATC',
    icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: false, // the menu bar is always there, like any Windows program
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, spellcheck: false },
  });
  if (cfg.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  const keep = () => { if (!win.isMaximized() && !win.isMinimized()) cfg.bounds = win.getBounds(); cfg.maximized = win.isMaximized(); save(); };
  win.on('resize', keep); win.on('move', keep); win.on('close', keep);
  // links to other sites (map credits, store pages) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (!sameSite(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!sameSite(url) && !url.startsWith('data:')) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) win.loadURL(failPage(desc || 'No connection')); });
  win.loadURL(serverUrl());
}

/* ---------- updates ----------
   The game server keeps the newest installer and electron-builder's latest.yml under /download/update/.
   The app checks there on start and every few hours, downloads a newer version in the background (with the
   sign-in cookie: the downloads sit behind the game's password), and offers to restart into it. */
const UPD = { manual: false, ready: null, timer: null };
async function checkUpdates(manual) {
  if (!autoUpdater || !app.isPackaged) { if (manual) dialog.showMessageBox(win, { type: 'info', title: 'Updates', message: 'Updates work in the installed app only.' }); return; }
  UPD.manual = !!manual;
  if (UPD.ready) return offerRestart(UPD.ready);
  try {
    const cookies = await session.defaultSession.cookies.get({ url: cfg.server === 'offline' ? SERVERS.online.url : serverUrl() });
    autoUpdater.requestHeaders = cookies.length ? { Cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') } : {};
    autoUpdater.setFeedURL({ provider: 'generic', url: (cfg.server === 'offline' ? SERVERS.online.url : serverUrl()) + '/download/update/' });
    await autoUpdater.checkForUpdates();
  } catch (e) {
    if (manual) dialog.showMessageBox(win, { type: 'warning', title: 'Updates', message: 'Could not check for updates.', detail: 'Sign in to the game first, and check your connection.\n\n' + String(e.message || e).slice(0, 200) });
  }
}
function offerRestart(info) {
  dialog.showMessageBox(win, { type: 'info', title: 'Update ready', message: `VECTOR ATC ${info.version} is ready to install.`, detail: 'Restart now to update, or it installs the next time you close the app.', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1 })
    .then(r => { if (r.response === 0) autoUpdater.quitAndInstall(true, true); });
}
function initUpdates() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true; autoUpdater.logger = null;
  autoUpdater.on('update-available', i => { if (UPD.manual) dialog.showMessageBox(win, { type: 'info', title: 'Updates', message: `Version ${i.version} is available.`, detail: 'It is downloading in the background; you will be asked to restart when it is ready.' }); });
  autoUpdater.on('update-not-available', () => { if (UPD.manual) dialog.showMessageBox(win, { type: 'info', title: 'Updates', message: `VECTOR ATC ${app.getVersion()} is the newest version.` }); });
  autoUpdater.on('download-progress', p => win && win.setProgressBar(p.percent / 100));
  autoUpdater.on('update-downloaded', i => { UPD.ready = i; win && win.setProgressBar(-1); offerRestart(i); });
  autoUpdater.on('error', () => win && win.setProgressBar(-1));
  // the first check once the game has loaded (and the player is signed in), then every four hours
  let first = true;
  win.webContents.on('did-finish-load', () => { if (first && sameSite(win.webContents.getURL()) && !/\/login/.test(win.webContents.getURL())) { first = false; setTimeout(() => checkUpdates(false), 8000); } });
  UPD.timer = setInterval(() => checkUpdates(false), 4 * 3600e3);
}

// the game's own settings window (audio devices, volumes, voices, weather, display, controls)
const view = v => win && win.webContents.executeJavaScript(`window.Views && Views.preset(${JSON.stringify(v)})`).catch(() => { });
const openSettings = tab => win && win.webContents.executeJavaScript(`window.Settings && Settings.open(${tab ? JSON.stringify(tab) : ''})`).catch(() => { });
function buildMenu() {
  const pick = async key => { if (key === 'offline') await startOffline(); cfg.server = key; save(); buildMenu(); win && win.loadURL(serverUrl()); };
  const settingsItem = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => openSettings() };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [settingsItem, { type: 'separator' }, { label: 'Audio devices…', click: () => openSettings('audio') }, { label: 'Weather and time…', click: () => openSettings('wx') }, { type: 'separator' }, { role: 'reload', label: 'Reload', accelerator: 'CmdOrCtrl+R' }, { type: 'separator' }, { role: 'quit', label: 'Exit', accelerator: 'Alt+F4' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, { ...settingsItem, accelerator: undefined }] },
    { label: 'View', submenu: [{ label: 'Tower', click: () => view('tower') }, { label: 'Ground radar', accelerator: '4', registerAccelerator: false, click: () => view('asde') }, { label: 'Approach radar', click: () => view('approach') }, { label: 'Final monitor', accelerator: '5', registerAccelerator: false, click: () => view('final') }, { label: 'Split', click: () => view('split') }, { type: 'separator' }, { label: 'Layers and views…', click: () => openSettings('view') }, { label: 'Accessibility…', click: () => openSettings('access') }, { type: 'separator' }, { role: 'togglefullscreen', label: 'Full screen', accelerator: 'F11' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { label: 'Display settings…', click: () => openSettings('display') }, { type: 'separator' }, { role: 'toggleDevTools', label: 'Developer tools' }] },
    { label: 'Server', submenu: Object.entries(SERVERS).map(([k, s]) => ({ label: s.label, type: 'radio', checked: cfg.server === k, click: () => pick(k) })) },
    { label: 'Help', submenu: [{ label: 'Keyboard shortcuts…', click: () => openSettings('controls') }, { type: 'separator' }, { label: 'Check for updates…', click: () => checkUpdates(true) }, { type: 'separator' }, { label: 'About VECTOR ATC', click: () => dialog.showMessageBox(win, { type: 'info', title: 'VECTOR ATC', message: `VECTOR ATC ${app.getVersion()}`, detail: `A voice air traffic control game.\nServer: ${serverUrl()}\n\nMap data © OpenStreetMap contributors.` }) }] },
  ]));
}

app.whenReady().then(async () => {
  if (cfg.server === 'offline' && !argServer) await startOffline();
  const ses = session.defaultSession;
  ses.setUserAgent(ses.getUserAgent() + ' VECTOR-Desktop/' + app.getVersion()); // the site hides its download button inside the app
  // the microphone, and choosing speakers, are for the game server only
  const AV = ['media', 'audioCapture', 'speaker-selection'];
  ses.setPermissionRequestHandler((wc, perm, cb, d) => cb(AV.includes(perm) && sameSite(d.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((wc, perm, origin) => AV.includes(perm) ? sameSite(origin) : true);
  buildMenu();
  createWindow();
  initUpdates();
});
// the home server's own certificate (made by its home certificate authority) is trusted for that address only
app.on('certificate-error', (e, wc, url, err, cert, cb) => {
  const home = new URL(SERVERS.home.url).host;
  let ok = false; try { ok = new URL(url).host === home && /VECTOR home network CA/.test(cert.issuerName || ''); } catch (x) { }
  if (ok) { e.preventDefault(); cb(true); } else cb(false);
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
