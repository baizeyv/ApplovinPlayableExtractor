const state = {
	sourceDir: "",
	selectedFile: "",
	selectedFilePath: "",
	scanResults: new Map(),
	runtimeResults: new Map(),
	previewFile: "",
	directoryHandle: null,
	directoryPath: "",
	runtimeScanToken: 0,
};

const RUNTIME_SETTLE_MS = 2200;
const RUNTIME_LOAD_TIMEOUT_MS = 7000;

const dom = {
	selectedPlayablePath: document.getElementById("selectedPlayablePath"),
	pickPlayableButton: document.getElementById("pickPlayableButton"),
	scanSelectedButton: document.getElementById("scanSelectedButton"),
	chooseDirectoryButton: document.getElementById("chooseDirectoryButton"),
	downloadSelectedButton: document.getElementById("downloadSelectedButton"),
	previewFrame: document.getElementById("previewFrame"),
	previewTitle: document.getElementById("previewTitle"),
	previewMeta: document.getElementById("previewMeta"),
	directoryStatus: document.getElementById("directoryStatus"),
	scanStatus: document.getElementById("scanStatus"),
	resourceSummary: document.getElementById("resourceSummary"),
	resourceTable: document.getElementById("resourceTable"),
};

const PICK_BUTTON_DEFAULT_TEXT = dom.pickPlayableButton.textContent.trim();
const desktopBridge = window.playableDesktop || null;

function formatBytes(bytes) {
	if (bytes == null || Number.isNaN(bytes)) return "大小未知";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sanitizeFileName(value) {
	return value
		.replace(/[\\/:*?"<>|]+/g, "_")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeMimeType(mimeType) {
	return mimeType.replace(/\\\//g, "/").replace(/\s+/g, "").toLowerCase();
}

function isSupportedMediaMimeType(mimeType) {
	return /^(image|audio|video)\//.test(mimeType);
}

function createDownloadFileName(playableName, resource, index) {
	const base = sanitizeFileName(playableName.replace(/\.html$/i, ""));
	const shortId = resource.id.slice(0, 10);
	return `${base}__${index + 1}_${shortId}.${resource.extension}`;
}

async function decodeDataUri(resource) {
	const commaIndex = resource.dataUri.indexOf(",");
	const header = resource.dataUri.slice(0, commaIndex);
	const payload = resource.dataUri.slice(commaIndex + 1);
	try {
		const response = await fetch(resource.dataUri);
		if (response.ok) {
			return response.blob();
		}
	} catch {
		// Fall through to manual decoding for recoverable malformed data URIs.
	}
	if (header.toLowerCase().includes(";base64")) {
		const binary = atob(payload.replace(/\s+/g, ""));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return new Blob([bytes], { type: resource.mimeType });
	}
	return new Blob([decodeURIComponent(payload)], { type: resource.mimeType });
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function getSelectedFile() {
	return state.selectedFile || "";
}

function renderSelectedPlayablePath() {
	dom.selectedPlayablePath.value = state.selectedFilePath || "";
}

function renderDirectoryStatus() {
	dom.directoryStatus.textContent =
		state.directoryPath ?
			`下载目录: ${state.directoryPath}`
		:	"未选择下载目录";
}

function clearPreview() {
	state.previewFile = "";
	dom.previewTitle.textContent = "未选择试玩";
	dom.previewMeta.textContent = "运行时监听未开始";
	dom.previewFrame.removeAttribute("src");
}

function mergeResourcesForFile(fileName) {
	if (!fileName) return [];
	const merged = new Map();
	const staticResources = state.scanResults.get(fileName)?.resources || [];
	const runtimeResources = state.runtimeResults.get(fileName) || [];

	for (const resource of [...staticResources, ...runtimeResources]) {
		if (!merged.has(resource.id)) {
			merged.set(resource.id, resource);
		}
	}

	return [...merged.values()];
}

function getSelectedResources() {
	const fileName = getSelectedFile();
	return mergeResourcesForFile(fileName).map((resource) => ({
		fileName,
		resource,
	}));
}

function renderResourceTable() {
	const fileName = getSelectedFile();
	const rows = fileName ? getSelectedResources() : [];
	dom.resourceSummary.textContent =
		fileName ? `${rows.length} 个资源` : "0 个资源";

	if (rows.length === 0) {
		dom.resourceTable.className = "resource-table empty-state";
		dom.resourceTable.textContent =
			fileName ?
				"当前试玩还没有资源，请先扫描或预览等待运行时捕获。"
			:	"先点击“选择 HTML”，再执行扫描或直接预览等待运行时捕获。";
		return;
	}

	dom.resourceTable.className = "resource-table";
	dom.resourceTable.innerHTML = "";
	rows.forEach(({ fileName: currentFile, resource }, index) => {
		const row = document.createElement("article");
		row.className = "resource-row";

		const content = document.createElement("div");
		content.className = "resource-content";
		content.innerHTML = `
      <strong>${escapeHtml(createDownloadFileName(currentFile, resource, index))}</strong>
      <div class="resource-meta">
        ${escapeHtml(resource.mimeType)} · ${escapeHtml(formatBytes(resource.sizeBytes))}<br>
        来源: ${escapeHtml(resource.source)}<br>
        入口试玩: ${escapeHtml(currentFile)}
      </div>
      <div class="resource-actions">
        <button type="button" class="copy-data-uri">复制 data URI</button>
        <button type="button" class="download-single">下载此项</button>
      </div>
    `;
		row.appendChild(content);

		const preview = document.createElement("div");
		preview.className = "resource-preview";
		if (resource.mimeType.startsWith("image/")) {
			const image = document.createElement("img");
			image.loading = "lazy";
			image.src = resource.dataUri;
			image.alt = createDownloadFileName(currentFile, resource, index);
			preview.appendChild(image);
		} else {
			const label = document.createElement("span");
			label.textContent =
				resource.mimeType.startsWith("audio/") ?
					"音频资源"
				:	"视频资源";
			preview.appendChild(label);
		}
		row.appendChild(preview);

		row.querySelector(".copy-data-uri").addEventListener(
			"click",
			async () => {
				await navigator.clipboard.writeText(resource.dataUri);
			},
		);
		row.querySelector(".download-single").addEventListener(
			"click",
			async () => {
				const blob = await decodeDataUri(resource);
				triggerBlobDownload(
					blob,
					createDownloadFileName(currentFile, resource, index),
				);
			},
		);
		dom.resourceTable.appendChild(row);
	});
}

function triggerBlobDownload(blob, fileName) {
	const objectUrl = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = objectUrl;
	anchor.download = fileName;
	anchor.click();
	URL.revokeObjectURL(objectUrl);
}

async function loadConfig() {
	const response = await fetch("/api/config");
	const payload = await response.json();
	state.sourceDir = payload.defaultSourceDir;
	renderSelectedPlayablePath();
	renderDirectoryStatus();
	renderResourceTable();
}

async function pickPlayable() {
	dom.scanStatus.textContent = "正在打开文件选择器...";
	dom.pickPlayableButton.disabled = true;
	dom.pickPlayableButton.textContent = "选择中...";
	try {
		const payload =
			desktopBridge ?
				await desktopBridge.pickPlayable(state.sourceDir)
			:	await fetch("/api/pick-playable", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ sourceDir: state.sourceDir }),
				}).then(async (response) => {
					const body = await response.json();
					if (!response.ok) {
						throw new Error(
							body.message || body.error || "选择 HTML 失败",
						);
					}
					return body;
				});
		if (payload.cancelled) {
			dom.scanStatus.textContent = "已取消选择 HTML";
			return;
		}

		state.sourceDir = payload.sourceDir;
		state.selectedFile = payload.fileName;
		state.selectedFilePath = payload.filePath;
		state.scanResults.clear();
		state.runtimeResults.clear();
		state.runtimeScanToken += 1;
		renderSelectedPlayablePath();
		renderResourceTable();
		dom.scanStatus.textContent = `已选择: ${payload.fileName}`;
		previewPlayable(payload.fileName);
	} finally {
		dom.pickPlayableButton.disabled = false;
		dom.pickPlayableButton.textContent = PICK_BUTTON_DEFAULT_TEXT;
	}
}

async function scanSelectedPlayables() {
	const fileName = getSelectedFile();
	if (!fileName) {
		throw new Error("请先选择一个试玩 HTML");
	}

	state.runtimeResults.delete(fileName);
	const runtimeScanToken = ++state.runtimeScanToken;
	dom.scanStatus.textContent = `正在扫描: ${fileName}`;
	const response = await fetch("/api/scan", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			sourceDir: state.sourceDir,
			fileNames: [fileName],
		}),
	});
	const payload = await response.json();
	if (!response.ok) {
		throw new Error(payload.message || payload.error || "扫描失败");
	}

	const result = payload.results[0];
	state.scanResults.set(result.fileName, result);
	renderResourceTable();

	dom.scanStatus.textContent = `静态扫描完成，正在运行时扫描: ${fileName}`;
	await collectRuntimeResourcesForPlayable(fileName, runtimeScanToken);
	renderResourceTable();

	const issueCount = result.issues.length;
	const totalResources = mergeResourcesForFile(fileName).length;
	dom.scanStatus.textContent = `扫描完成，发现 ${totalResources} 个资源${issueCount ? `，${issueCount} 个请求/读取异常` : ""}`;
}

function waitForPreviewFrameLoad(frame, token) {
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			frame.removeEventListener("load", onLoad);
			clearTimeout(loadTimer);
			resolve();
		};
		const onLoad = () => {
			setTimeout(() => {
				if (token === state.runtimeScanToken) {
					finish();
				}
			}, RUNTIME_SETTLE_MS);
		};
		const loadTimer = setTimeout(finish, RUNTIME_LOAD_TIMEOUT_MS);
		frame.addEventListener("load", onLoad, { once: true });
	});
}

async function collectRuntimeResourcesForPlayable(fileName, token) {
	if (token !== state.runtimeScanToken) {
		return;
	}
	const loadPromise = waitForPreviewFrameLoad(dom.previewFrame, token);
	previewPlayable(fileName);
	await loadPromise;
}

function previewPlayable(fileName) {
	if (!fileName) {
		clearPreview();
		return;
	}
	state.selectedFile = fileName;
	state.previewFile = fileName;
	dom.previewTitle.textContent = fileName;
	dom.previewMeta.textContent = "运行时监听进行中";
	dom.previewFrame.src = `/preview?sourceDir=${encodeURIComponent(state.sourceDir)}&file=${encodeURIComponent(fileName)}`;
	renderResourceTable();
}

async function chooseDirectory() {
	if (desktopBridge) {
		const payload = await desktopBridge.pickDownloadDirectory();
		if (payload.cancelled) {
			return;
		}
		state.directoryHandle = null;
		state.directoryPath = payload.directoryPath;
		renderDirectoryStatus();
		return;
	}
	if (!("showDirectoryPicker" in window)) {
		throw new Error(
			"当前浏览器不支持目录选择。请使用最新版 Edge 或 Chrome 打开。",
		);
	}
	state.directoryHandle = await window.showDirectoryPicker({
		mode: "readwrite",
	});
	state.directoryPath = state.directoryHandle.name;
	renderDirectoryStatus();
}

async function saveResourcesToDirectory() {
	const resources = getSelectedResources();
	const fileName = getSelectedFile();
	if (!fileName || resources.length === 0) {
		throw new Error("当前试玩没有可下载资源，请先扫描或预览试玩");
	}

	if (!state.directoryHandle) {
		await chooseDirectory();
	}
	if (!state.directoryHandle && !state.directoryPath) {
		throw new Error("请先选择下载目录");
	}

	dom.scanStatus.textContent = `正在写入 ${resources.length} 个文件...`;
	if (desktopBridge && state.directoryPath) {
		const result = await desktopBridge.saveResources({
			directoryPath: state.directoryPath,
			files: resources.map((item, index) => ({
				fileName: createDownloadFileName(
					item.fileName,
					item.resource,
					index,
				),
				dataUri: item.resource.dataUri,
			})),
		});
		dom.scanStatus.textContent = `下载完成，已写入 ${result.savedCount} 个文件`;
		return;
	}
	for (let index = 0; index < resources.length; index += 1) {
		const item = resources[index];
		const downloadName = createDownloadFileName(
			item.fileName,
			item.resource,
			index,
		);
		const fileHandle = await state.directoryHandle.getFileHandle(
			downloadName,
			{
				create: true,
			},
		);
		const writable = await fileHandle.createWritable();
		await writable.write(await decodeDataUri(item.resource));
		await writable.close();
	}
	dom.scanStatus.textContent = `下载完成，已写入 ${resources.length} 个文件`;
}

function estimateRuntimeDataUriSize(dataUri) {
	const commaIndex = dataUri.indexOf(",");
	const header = dataUri.slice(0, commaIndex).toLowerCase();
	const payload = dataUri.slice(commaIndex + 1);
	try {
		if (header.includes(";base64")) {
			return Math.floor((payload.length * 3) / 4);
		}
		return decodeURIComponent(payload).length;
	} catch {
		return null;
	}
}

function extensionForMime(mimeType) {
	const normalized = normalizeMimeType(mimeType);
	if (normalized.includes("png")) return "png";
	if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
	if (normalized.includes("webp")) return "webp";
	if (normalized.includes("gif")) return "gif";
	if (normalized.includes("avif")) return "avif";
	if (normalized.includes("svg")) return "svg";
	if (normalized.includes("mp4")) return "mp4";
	if (normalized.includes("webm")) return "webm";
	if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
	if (normalized.includes("ogg")) return "ogg";
	if (normalized.includes("wav")) return "wav";
	return normalized.split("/").pop() || "bin";
}

function awaitHash(value) {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = (hash << 5) - hash + value.charCodeAt(index);
		hash |= 0;
	}
	return `rt_${Math.abs(hash).toString(16)}`;
}

function registerRuntimeCollector() {
	window.addEventListener("message", (event) => {
		if (!event.data || event.data.source !== "playable-extractor") {
			return;
		}

		const fileName = event.data.payload?.entryFileName || state.previewFile;
		if (!fileName) {
			return;
		}

		if (event.data.type === "status") {
			dom.previewMeta.textContent = `运行时监听已挂载 · ${fileName}`;
			return;
		}

		if (event.data.type !== "resource") {
			return;
		}

		const dataUri = event.data.payload?.dataUri;
		const match = /^data:([^,]+),/i.exec(dataUri || "");
		if (!match) return;
		const mimeType = normalizeMimeType(match[1].split(";")[0]);
		if (!isSupportedMediaMimeType(mimeType)) return;

		const resource = {
			id: awaitHash(dataUri),
			source: `${fileName} runtime:${event.data.payload.channel}`,
			dataUri,
			mimeType,
			extension: extensionForMime(mimeType),
			sizeBytes: estimateRuntimeDataUriSize(dataUri),
		};

		const existing = state.runtimeResults.get(fileName) || [];
		if (!existing.some((item) => item.id === resource.id)) {
			existing.push(resource);
			state.runtimeResults.set(fileName, existing);
			renderResourceTable();
		}
	});
}

function registerActions() {
	dom.pickPlayableButton.addEventListener(
		"click",
		runWithStatus(pickPlayable),
	);
	dom.scanSelectedButton.addEventListener(
		"click",
		runWithStatus(scanSelectedPlayables),
	);
	dom.chooseDirectoryButton.addEventListener(
		"click",
		runWithStatus(chooseDirectory),
	);
	dom.downloadSelectedButton.addEventListener(
		"click",
		runWithStatus(saveResourcesToDirectory),
	);
}

function runWithStatus(task) {
	return async () => {
		try {
			await task();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			dom.scanStatus.textContent = message;
			console.error(error);
		}
	};
}

async function bootstrap() {
	registerActions();
	registerRuntimeCollector();
	await loadConfig();
}

bootstrap().catch((error) => {
	dom.scanStatus.textContent =
		error instanceof Error ? error.message : String(error);
	console.error(error);
});
