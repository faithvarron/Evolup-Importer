const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');
const net = require('net');

// Set user data paths BEFORE requiring any app modules
const userData = app.getPath('userData');
process.env.ELECTRON_USER_DATA = userData;
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(userData, 'ms-playwright');

let mainWindow;

function getAppRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app')
    : __dirname;
}

async function ensurePlaywrightBrowsers() {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const alreadyInstalled =
    fs.existsSync(browsersPath) &&
    fs.readdirSync(browsersPath).some((d) => d.startsWith('chromium'));

  if (alreadyInstalled) return;

  const loadingWin = new BrowserWindow({
    width: 480,
    height: 130,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  loadingWin.loadURL(
    `data:text/html,<html><body style="background:#1e293b;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:20px;box-sizing:border-box;border-radius:10px"><p style="text-align:center;font-size:15px;line-height:1.6">⚙️ Installing browser components…<br><small style="opacity:.7">One-time setup, may take a few minutes.</small></p></body></html>`
  );

  try {
    const playwrightCli = path.join(getAppRoot(), 'node_modules', 'playwright', 'cli.js');
    execSync(`node "${playwrightCli}" install chromium`, {
      env: { ...process.env },
      timeout: 300000,
    });
  } catch (e) {
    loadingWin.close();
    dialog.showErrorBox(
      'Setup Failed',
      `Could not install browser components:\n\n${e.message}`
    );
    app.quit();
    return;
  }

  loadingWin.close();
}

function waitForPort(port) {
  return new Promise((resolve) => {
    const tryConnect = () => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.destroy();
        resolve();
      });
      sock.on('error', () => setTimeout(tryConnect, 200));
    };
    tryConnect();
  });
}

async function startServer() {
  require(path.join(getAppRoot(), 'server.js'));
  await waitForPort(3000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    title: 'Evolup Importer',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL('http://localhost:3000');
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await ensurePlaywrightBrowsers();
    await startServer();
    createWindow();
  } catch (e) {
    dialog.showErrorBox('Startup Error', e.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
