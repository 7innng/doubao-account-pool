const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dolaTcp", {
  request: (connection, command) => ipcRenderer.invoke("tcp:request", connection, command),
  video: (connection, command) => ipcRenderer.invoke("tcp:video", connection, command),
  saveVideo: (filePath, suggestedName) => ipcRenderer.invoke("tcp:save-video", filePath, suggestedName)
});
