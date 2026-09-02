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
	previewFitTimeouts: [],
};

const RUNTIME_SETTLE_MS = 2200;
const RUNTIME_LOAD_TIMEOUT_MS = 7000;

const dom = {
	selectedPlayablePath: document.getElementById("selectedPlayablePath"),
	pickPlayableButton: document.getElementById("pickPlayableButton"),
	scanSelectedButton: document.getElementById("scanSelectedButton"),
	chooseDirectoryButton: document.getElementById("chooseDirectoryButton"),
	downloadSelectedButton: document.getElementById("downloadSelectedButton"),
	workspaceLayout: document.getElementById("workspaceLayout"),
	leftColumn: document.querySelector(".left-column"),
	previewPanel: document.querySelector(".preview-panel"),
	previewCornerResizer: document.getElementById("previewCornerResizer"),
	previewSurface: document.querySelector(".preview-surface"),
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
const PREVIEW_WIDTH_STORAGE_KEY = "playable-preview-width";
const PREVIEW_HEIGHT_STORAGE_KEY = "playable-preview-height";
const MIN_PREVIEW_WIDTH = 360;
const MAX_PREVIEW_WIDTH = 920;
const LEGACY_MIN_PREVIEW_WIDTH = 420;
const MIN_LEFT_WIDTH = 420;
const DEFAULT_LEFT_WIDTH = 480;
const MIN_PREVIEW_HEIGHT = 420;
const MAX_PREVIEW_HEIGHT = 1200;
const RESIZER_TRACK_SIZE = 0;
const WORKSPACE_COLUMN_GAP = 18;
const WORKSPACE_TOTAL_GAP = WORKSPACE_COLUMN_GAP;

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

function setPreviewTitle(value) {
	const text = value || "未选择试玩";
	dom.previewTitle.textContent = text;
	dom.previewTitle.title = text;
}

function clearPreview() {
	state.previewFile = "";
	setPreviewTitle("未选择试玩");
	dom.previewMeta.textContent = "运行时监听未开始";
	dom.previewFrame.removeAttribute("src");
}

function clearPreviewFitTimers() {
	for (const timeoutId of state.previewFitTimeouts) {
		clearTimeout(timeoutId);
	}
	state.previewFitTimeouts = [];
}

function fitPreviewFrameContent() {
	const frameWindow = dom.previewFrame.contentWindow;
	const frameDocument = dom.previewFrame.contentDocument;
	if (
		!frameWindow ||
		!frameDocument?.documentElement ||
		!frameDocument.body
	) {
		return;
	}
	if (frameDocument.documentElement.dataset.playablePreviewAutofit === "1") {
		return;
	}

	const html = frameDocument.documentElement;
	const body = frameDocument.body;
	const frameWidth = dom.previewFrame.clientWidth;
	const frameHeight = dom.previewFrame.clientHeight;
	if (frameWidth <= 0 || frameHeight <= 0) {
		return;
	}

	const previousTransform = body.style.transform;
	const previousTransformOrigin = body.style.transformOrigin;
	const previousWidth = body.style.width;
	const previousHeight = body.style.height;
	const previousMargin = body.style.margin;
	const previousHtmlOverflow = html.style.overflow;
	const previousBodyOverflow = body.style.overflow;

	body.style.transform = "none";
	body.style.transformOrigin = "top left";
	body.style.width = "";
	body.style.height = "";
	body.style.margin = "0";
	html.style.overflow = "hidden";
	body.style.overflow = "hidden";

	const naturalWidth = Math.max(
		html.scrollWidth,
		body.scrollWidth,
		html.clientWidth,
		body.clientWidth,
	);
	const naturalHeight = Math.max(
		html.scrollHeight,
		body.scrollHeight,
		html.clientHeight,
		body.clientHeight,
	);

	const widthScale = naturalWidth > 0 ? frameWidth / naturalWidth : 1;
	const heightScale = naturalHeight > 0 ? frameHeight / naturalHeight : 1;
	const scale = Math.min(1, widthScale, heightScale);

	body.style.margin = "0";
	body.style.width = `${naturalWidth}px`;
	body.style.height = `${naturalHeight}px`;
	body.style.transformOrigin = "top left";
	body.style.transform = `scale(${scale})`;
	html.style.overflow = "hidden";
	body.style.overflow = "hidden";

	body.dataset.playablePreviewOriginalTransform = previousTransform;
	body.dataset.playablePreviewOriginalTransformOrigin =
		previousTransformOrigin;
	body.dataset.playablePreviewOriginalWidth = previousWidth;
	body.dataset.playablePreviewOriginalHeight = previousHeight;
	body.dataset.playablePreviewOriginalMargin = previousMargin;
	html.dataset.playablePreviewOriginalOverflow = previousHtmlOverflow;
	body.dataset.playablePreviewOriginalOverflow = previousBodyOverflow;
	body.dataset.playablePreviewScale = String(scale);
}

function schedulePreviewFit() {
	clearPreviewFitTimers();
	const delays = [0, 120, 500, 1400, 2800];
	for (const delay of delays) {
		const timeoutId = window.setTimeout(() => {
			fitPreviewFrameContent();
		}, delay);
		state.previewFitTimeouts.push(timeoutId);
	}
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
		const downloadName = createDownloadFileName(
			currentFile,
			resource,
			index,
		);
		const resourceKind = resource.mimeType.split("/")[0];
		const extensionLabel = (resource.extension || "bin").toUpperCase();

		const content = document.createElement("div");
		content.className = "resource-content";
		content.innerHTML = `
		<div class="resource-row-top">
			<strong class="resource-file-name" title="${escapeHtml(downloadName)}">${escapeHtml(downloadName)}</strong>
			<span class="resource-size-badge">${escapeHtml(formatBytes(resource.sizeBytes))}</span>
		</div>
		<div class="resource-origin">
			<span class="resource-badge">${escapeHtml(resourceKind)}</span>
			<span class="resource-badge subtle">${escapeHtml(extensionLabel)}</span>
		</div>
		<div class="resource-meta-group">
			<div class="resource-meta-line">
				<span class="resource-meta-label">入口</span>
				<span class="resource-meta-value" title="${escapeHtml(currentFile)}">${escapeHtml(currentFile)}</span>
			</div>
			<div class="resource-meta-line">
				<span class="resource-meta-label">来源</span>
				<span class="resource-meta-value" title="${escapeHtml(resource.source)}">${escapeHtml(resource.source)}</span>
			</div>
		</div>
    `;

		const preview = document.createElement("div");
		preview.className = "resource-preview";
		if (resource.mimeType.startsWith("image/")) {
			const image = document.createElement("img");
			image.loading = "lazy";
			image.src = resource.dataUri;
			image.alt = downloadName;
			preview.appendChild(image);
		} else {
			const label = document.createElement("span");
			label.textContent =
				resource.mimeType.startsWith("audio/") ?
					"音频资源"
				:	"视频资源";
			preview.appendChild(label);
		}

		const primary = document.createElement("div");
		primary.className = "resource-primary";
		primary.appendChild(preview);
		primary.appendChild(content);
		row.appendChild(primary);

		const actions = document.createElement("div");
		actions.className = "resource-actions";
		actions.innerHTML = `
		<button type="button" class="copy-data-uri">复制 data URI</button>
		<button type="button" class="download-single">下载此项</button>
    `;
		row.appendChild(actions);

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
				triggerBlobDownload(blob, downloadName);
			},
		);
		dom.resourceTable.appendChild(row);
	});
}

function clampPreviewWidth(width) {
	return Math.max(MIN_PREVIEW_WIDTH, Math.min(MAX_PREVIEW_WIDTH, width));
}

function getCurrentLeftColumnWidth() {
	const storedWidth = Number.parseInt(
		getComputedStyle(document.documentElement).getPropertyValue(
			"--left-column-width",
		),
		10,
	);
	if (Number.isFinite(storedWidth)) {
		return storedWidth;
	}
	const measuredWidth = dom.leftColumn?.getBoundingClientRect().width;
	return Number.isFinite(measuredWidth) ? measuredWidth : MIN_LEFT_WIDTH;
}

function syncLeftColumnWidth(preferredWidth) {
	if (!dom.workspaceLayout || !dom.leftColumn) {
		return;
	}
	if (window.innerWidth <= 900) {
		document.documentElement.style.removeProperty("--left-column-width");
		return;
	}

	const workspaceWidth = dom.workspaceLayout.getBoundingClientRect().width;
	const maxLeftWidth = Math.max(
		MIN_LEFT_WIDTH,
		Math.floor(
			workspaceWidth -
				MIN_PREVIEW_WIDTH -
				RESIZER_TRACK_SIZE -
				WORKSPACE_TOTAL_GAP,
		),
	);
	const measuredWidth = dom.leftColumn.getBoundingClientRect().width;
	const storedWidth = Number.parseInt(
		getComputedStyle(document.documentElement).getPropertyValue(
			"--left-column-width",
		),
		10,
	);
	const targetWidth =
		preferredWidth ??
		(Number.isFinite(storedWidth) ? storedWidth
		: Number.isFinite(measuredWidth) && measuredWidth > 0 ?
			Math.min(measuredWidth, DEFAULT_LEFT_WIDTH)
		:	DEFAULT_LEFT_WIDTH);
	const nextWidth = Math.max(
		MIN_LEFT_WIDTH,
		Math.min(maxLeftWidth, Math.floor(targetWidth)),
	);
	document.documentElement.style.setProperty(
		"--left-column-width",
		`${nextWidth}px`,
	);
}

function getMaxPreviewWidth() {
	if (!dom.workspaceLayout) {
		return MAX_PREVIEW_WIDTH;
	}
	const availableWidth = dom.workspaceLayout.getBoundingClientRect().width;
	const leftWidth = getCurrentLeftColumnWidth();
	return Math.max(
		MIN_PREVIEW_WIDTH,
		Math.min(
			MAX_PREVIEW_WIDTH,
			availableWidth -
				leftWidth -
				RESIZER_TRACK_SIZE -
				WORKSPACE_TOTAL_GAP,
		),
	);
}

function setPreviewWidth(width) {
	const nextWidth = clampPreviewWidth(width);
	document.documentElement.style.setProperty(
		"--preview-width",
		`${nextWidth}px`,
	);
	schedulePreviewFit();
	try {
		window.localStorage.setItem(
			PREVIEW_WIDTH_STORAGE_KEY,
			String(nextWidth),
		);
	} catch {
		// Ignore storage failures in locked-down environments.
	}
}

function loadStoredPreviewWidth() {
	try {
		const storedValue = window.localStorage.getItem(
			PREVIEW_WIDTH_STORAGE_KEY,
		);
		const parsed = Number.parseInt(storedValue || "", 10);
		if (Number.isFinite(parsed)) {
			const nextWidth =
				parsed === LEGACY_MIN_PREVIEW_WIDTH ? MIN_PREVIEW_WIDTH : (
					parsed
				);
			setPreviewWidth(nextWidth);
			return true;
		}
	} catch {
		// Ignore storage failures in locked-down environments.
	}
	return false;
}

function clampPreviewHeight(height) {
	const panel = dom.previewPanel;
	const surface = dom.previewSurface;
	if (!panel || !surface) {
		return Math.max(
			MIN_PREVIEW_HEIGHT,
			Math.min(MAX_PREVIEW_HEIGHT, height),
		);
	}

	const panelRect = panel.getBoundingClientRect();
	const surfaceRect = surface.getBoundingClientRect();
	const workspaceRect = dom.workspaceLayout?.getBoundingClientRect();
	const panelChromeHeight = panelRect.height - surfaceRect.height;
	const visibleBottom = Math.min(
		window.innerHeight,
		workspaceRect?.bottom ?? window.innerHeight,
	);
	const availableHeight = visibleBottom - panelRect.top - panelChromeHeight;
	const dynamicMaxHeight = Math.max(
		MIN_PREVIEW_HEIGHT,
		Math.min(MAX_PREVIEW_HEIGHT, Math.floor(availableHeight)),
	);
	if (dom.previewCornerResizer) {
		dom.previewCornerResizer.setAttribute(
			"aria-valuemax",
			String(dynamicMaxHeight),
		);
	}
	return Math.max(MIN_PREVIEW_HEIGHT, Math.min(dynamicMaxHeight, height));
}

function setPreviewHeight(height) {
	const nextHeight = clampPreviewHeight(height);
	document.documentElement.style.setProperty(
		"--preview-height",
		`${nextHeight}px`,
	);
	schedulePreviewFit();
	try {
		window.localStorage.setItem(
			PREVIEW_HEIGHT_STORAGE_KEY,
			String(nextHeight),
		);
	} catch {
		// Ignore storage failures in locked-down environments.
	}
}

function syncPreviewHeightToViewport() {
	const currentHeight = Number.parseInt(
		getComputedStyle(document.documentElement).getPropertyValue(
			"--preview-height",
		),
		10,
	);
	if (Number.isFinite(currentHeight)) {
		setPreviewHeight(currentHeight);
	}
}

function loadStoredPreviewHeight() {
	try {
		const storedValue = window.localStorage.getItem(
			PREVIEW_HEIGHT_STORAGE_KEY,
		);
		const parsed = Number.parseInt(storedValue || "", 10);
		if (Number.isFinite(parsed)) {
			setPreviewHeight(parsed);
			return true;
		}
	} catch {
		// Ignore storage failures in locked-down environments.
	}
	return false;
}

function registerPreviewResizer() {
	const cornerResizer = dom.previewCornerResizer;
	const workspace = dom.workspaceLayout;
	if (!cornerResizer || !workspace) {
		return;
	}

	const getCurrentWidth = () => {
		const width = Number.parseInt(
			getComputedStyle(document.documentElement).getPropertyValue(
				"--preview-width",
			),
			10,
		);
		return Number.isFinite(width) ? width : 520;
	};

	const getCurrentHeight = () => {
		const height = Number.parseInt(
			getComputedStyle(document.documentElement).getPropertyValue(
				"--preview-height",
			),
			10,
		);
		return Number.isFinite(height) ? height : 680;
	};

	const applyCornerWidthDelta = (startWidth, deltaX) => {
		if (window.innerWidth <= 900) {
			return;
		}
		const maxWidth = getMaxPreviewWidth();
		if (maxWidth < MIN_PREVIEW_WIDTH) {
			return;
		}
		setPreviewWidth(startWidth + deltaX);
	};

	const applyHeightDelta = (startHeight, deltaY) => {
		setPreviewHeight(startHeight + deltaY);
	};

	const startPointerResize = (event, onMove) => {
		event.preventDefault();
		document.body.classList.add("is-resizing");
		event.currentTarget.setPointerCapture?.(event.pointerId);

		const handlePointerMove = (moveEvent) => {
			onMove(moveEvent);
		};

		const stopResize = () => {
			document.body.classList.remove("is-resizing");
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", stopResize);
		};

		window.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", stopResize, { once: true });
	};

	cornerResizer.addEventListener("pointerdown", (event) => {
		const startX = event.clientX;
		const startY = event.clientY;
		const startWidth = getCurrentWidth();
		const startHeight = getCurrentHeight();
		syncLeftColumnWidth();
		startPointerResize(event, (moveEvent) => {
			applyCornerWidthDelta(startWidth, moveEvent.clientX - startX);
			applyHeightDelta(startHeight, moveEvent.clientY - startY);
		});
	});

	cornerResizer.addEventListener("keydown", (event) => {
		const currentWidth = getCurrentWidth();
		const currentHeight = getCurrentHeight();
		syncLeftColumnWidth();
		if (event.key === "ArrowLeft") {
			event.preventDefault();
			setPreviewWidth(currentWidth - 24);
		}
		if (event.key === "ArrowRight") {
			event.preventDefault();
			setPreviewWidth(currentWidth + 24);
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			setPreviewHeight(currentHeight - 24);
		}
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setPreviewHeight(currentHeight + 24);
		}
	});
}

function registerPreviewAutoFit() {
	dom.previewFrame.addEventListener("load", () => {
		syncPreviewHeightToViewport();
		schedulePreviewFit();
	});

	window.addEventListener("resize", () => {
		syncLeftColumnWidth(getCurrentLeftColumnWidth());
		const currentWidth = Number.parseInt(
			getComputedStyle(document.documentElement).getPropertyValue(
				"--preview-width",
			),
			10,
		);
		if (Number.isFinite(currentWidth)) {
			setPreviewWidth(currentWidth);
		}
		syncPreviewHeightToViewport();
		schedulePreviewFit();
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
	setPreviewTitle(fileName);
	dom.previewMeta.textContent = "运行时监听进行中";
	clearPreviewFitTimers();
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
			dom.previewMeta.textContent = "运行时监听已挂载";
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
	syncLeftColumnWidth(DEFAULT_LEFT_WIDTH);
	const hasStoredPreviewWidth = loadStoredPreviewWidth();
	const hasStoredPreviewHeight = loadStoredPreviewHeight();
	if (!hasStoredPreviewWidth) {
		setPreviewWidth(getMaxPreviewWidth());
	}
	if (!hasStoredPreviewHeight) {
		setPreviewHeight(MAX_PREVIEW_HEIGHT);
	}
	syncPreviewHeightToViewport();
	registerActions();
	registerRuntimeCollector();
	registerPreviewResizer();
	registerPreviewAutoFit();
	await loadConfig();
}

bootstrap().catch((error) => {
	dom.scanStatus.textContent =
		error instanceof Error ? error.message : String(error);
	console.error(error);
});
