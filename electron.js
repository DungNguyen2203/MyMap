const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// Ghi log ra file để debug
const logFile = path.join(__dirname, 'electron-debug.log');
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logFile, logMessage);
  console.log(message);
}

log('📦 Electron script started!');

let mainWindow;

function createWindow() {
  log('🪟 Creating Electron window...');
  
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    show: false, // Không show ngay, đợi ready-to-show
    backgroundColor: '#1a1a2e',
    title: 'MindTree - Mind Mapping App'
  });

  // Load app từ localhost (server đã chạy sẵn)
  log('🌐 Loading http://localhost:3000...');
  mainWindow.loadURL('http://localhost:3000');

  // Show window khi đã load xong
  mainWindow.once('ready-to-show', () => {
    log('✅ Window ready, showing now...');
    mainWindow.show();
    mainWindow.focus();
  });

  // Debug: Mở DevTools
  mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Log khi có lỗi
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error('❌ Failed to load:', errorDescription);
  });
}

// Đợi Electron ready
app.whenReady().then(() => {
  log('🚀 Electron app ready!');
  
  // Đợi 2 giây để đảm bảo server đã chạy
  setTimeout(() => {
    createWindow();
  }, 2000);
});

app.on('window-all-closed', () => {
  log('🚪 All windows closed');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

log('📝 Electron main process configured');