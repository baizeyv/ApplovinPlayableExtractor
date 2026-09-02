const path = require("path");
const fsp = require("fs/promises");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { startServer } = require("../server");

let mainWindow = null;
let serverHandle = null;

function createWindow(appUrl) {
	mainWindow = new BrowserWindow({
		width: 1600,
		height: 980,
		minWidth: 1280,
		minHeight: 820,
		autoHideMenuBar: true,
		backgroundColor: "#f3ede2",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: path.join(__dirname, "preload.js"),
		},
	});

	mainWindow.loadURL(appUrl);
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

function decodeDataUriToBuffer(dataUri) {
	const commaIndex = String(dataUri || "").indexOf(",");
	if (commaIndex === -1) {
		throw new Error("Invalid data URI");
	}
	const header = dataUri.slice(0, commaIndex).toLowerCase();
	const payload = dataUri.slice(commaIndex + 1);
	if (header.includes(";base64")) {
		return Buffer.from(payload.replace(/\s+/g, ""), "base64");
	}
	return Buffer.from(decodeURIComponent(payload), "utf8");
}

function sanitizeOutputFileName(fileName) {
	return path.basename(String(fileName || "resource.bin"));
}

function registerIpcHandlers() {
	ipcMain.handle("playable:pick-html", async (_event, payload) => {
		const result = await dialog.showOpenDialog(mainWindow, {
			title: "选择试玩 HTML",
			defaultPath: payload?.sourceDir || app.getPath("documents"),
			properties: ["openFile"],
			filters: [{ name: "HTML Files", extensions: ["html", "htm"] }],
		});
		if (result.canceled || !result.filePaths[0]) {
			return { cancelled: true };
		}
		const filePath = result.filePaths[0];
		return {
			cancelled: false,
			filePath,
			fileName: path.basename(filePath),
			sourceDir: path.dirname(filePath),
		};
	});

	ipcMain.handle("playable:pick-download-directory", async () => {
		const result = await dialog.showOpenDialog(mainWindow, {
			title: "选择下载目录",
			defaultPath: app.getPath("downloads"),
			properties: ["openDirectory", "createDirectory"],
		});
		if (result.canceled || !result.filePaths[0]) {
			return { cancelled: true };
		}
		const directoryPath = result.filePaths[0];
		return {
			cancelled: false,
			directoryPath,
			name: path.basename(directoryPath),
		};
	});

	ipcMain.handle("playable:save-resources", async (_event, payload) => {
		const directoryPath = path.resolve(
			String(payload?.directoryPath || ""),
		);
		const files = Array.isArray(payload?.files) ? payload.files : [];
		if (!directoryPath) {
			throw new Error("Missing directory path");
		}
		await fsp.mkdir(directoryPath, { recursive: true });
		for (const file of files) {
			const targetPath = path.join(
				directoryPath,
				sanitizeOutputFileName(file.fileName),
			);
			await fsp.writeFile(
				targetPath,
				decodeDataUriToBuffer(file.dataUri),
			);
		}
		return { savedCount: files.length };
	});
}

async function boot() {
	registerIpcHandlers();
	serverHandle = await startServer({
		port: 0,
		shouldAutoOpenBrowser: false,
		staticRoot: path.resolve(__dirname, ".."),
	});
	createWindow(serverHandle.url);
}

app.whenReady().then(boot);

app.on("window-all-closed", async () => {
	if (serverHandle) {
		await serverHandle.close().catch(() => {});
		serverHandle = null;
	}
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("activate", async () => {
	if (!mainWindow && serverHandle) {
		createWindow(serverHandle.url);
	}
});
