const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("playableDesktop", {
	isElectron: true,
	pickPlayable: (sourceDir) =>
		ipcRenderer.invoke("playable:pick-html", { sourceDir }),
	pickDownloadDirectory: () =>
		ipcRenderer.invoke("playable:pick-download-directory"),
	saveResources: (payload) =>
		ipcRenderer.invoke("playable:save-resources", payload),
});
