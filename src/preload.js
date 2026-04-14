const { contextBridge, ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {});

// Bridge for CLI processor renderer. Inert for the normal GUI renderer.
contextBridge.exposeInMainWorld('mosaicCli', {
    onStart: (cb) => ipcRenderer.on('mosaic:start', (_e, payload) => cb(payload)),
    // invoke() awaits main-side backpressure before resolving — natural flow control
    sendFrame: (buffer) => ipcRenderer.invoke('mosaic:frame', buffer),
    done: () => ipcRenderer.send('mosaic:done'),
    error: (msg) => ipcRenderer.send('mosaic:error', String(msg)),
    ready: () => ipcRenderer.send('mosaic:ready')
});
