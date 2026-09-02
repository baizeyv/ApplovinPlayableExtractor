const http = require("http");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFile } = require("child_process");
const { URL } = require("url");

const DEFAULT_PORT = Number(process.env.PORT || 7733);
const DEFAULT_SOURCE_DIR =
	process.env.PLAYABLE_SOURCE_DIR || "d:\\svn-repo\\yatzy\\yatzy试玩";
const MAX_SCAN_DEPTH = 3;
const DEFAULT_RUNTIME_SETTLE_MS = 2200;
const IS_PACKAGED = typeof process.pkg !== "undefined";
const DEFAULT_SHOULD_AUTO_OPEN_BROWSER =
	process.env.AUTO_OPEN_BROWSER === "1" ||
	(process.env.AUTO_OPEN_BROWSER !== "0" && IS_PACKAGED);
const DEFAULT_STATIC_ROOT = __dirname;
const TEXT_EXTENSIONS = new Set([
	".html",
	".htm",
	".js",
	".json",
	".txt",
	".xml",
	".atlas",
	".css",
	".mjs",
	".cjs",
]);
const MIME_TO_EXTENSION = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
	"image/svg+xml": "svg",
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/ogg": "ogg",
	"audio/wav": "wav",
	"audio/webm": "webm",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"application/json": "json",
	"text/plain": "txt",
	"application/octet-stream": "bin",
};
const EXTENSION_TO_MIME = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	avif: "image/avif",
	svg: "image/svg+xml",
	mp3: "audio/mpeg",
	ogg: "audio/ogg",
	wav: "audio/wav",
	webm: "video/webm",
	mp4: "video/mp4",
};

const runtimeConfig = {
	port: DEFAULT_PORT,
	defaultSourceDir: DEFAULT_SOURCE_DIR,
	shouldAutoOpenBrowser: DEFAULT_SHOULD_AUTO_OPEN_BROWSER,
	staticRoot: DEFAULT_STATIC_ROOT,
	pickPlayableFile: null,
};

function sendJson(res, statusCode, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
	});
	res.end(body);
}

function sendText(
	res,
	statusCode,
	body,
	contentType = "text/plain; charset=utf-8",
) {
	res.writeHead(statusCode, {
		"Content-Type": contentType,
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
	});
	res.end(body);
}

function notFound(res) {
	sendJson(res, 404, { error: "Not found" });
}

function parseRequestBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			try {
				const text = Buffer.concat(chunks).toString("utf8");
				resolve(text ? JSON.parse(text) : {});
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

function getMimeType(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8";
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
		return "text/javascript; charset=utf-8";
	}
	if (ext === ".css") return "text/css; charset=utf-8";
	if (ext === ".json") return "application/json; charset=utf-8";
	if (ext === ".svg") return "image/svg+xml";
	if (ext === ".png") return "image/png";
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	if (ext === ".mp3") return "audio/mpeg";
	if (ext === ".ogg") return "audio/ogg";
	if (ext === ".wav") return "audio/wav";
	if (ext === ".webm") return "video/webm";
	if (ext === ".mp4") return "video/mp4";
	return "application/octet-stream";
}

function ensurePlayableSourceDir(sourceDir) {
	return path.resolve(sourceDir || runtimeConfig.defaultSourceDir);
}

function ensureInside(baseDir, targetPath) {
	const relativePath = path.relative(
		path.resolve(baseDir),
		path.resolve(targetPath),
	);
	return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

function escapePowerShellSingleQuoted(value) {
	return String(value || "").replace(/'/g, "''");
}

function execFileAsync(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		execFile(command, args, options, (error, stdout, stderr) => {
			if (error) {
				error.stdout = stdout;
				error.stderr = stderr;
				reject(error);
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

function openBrowser(url) {
	if (process.platform === "win32") {
		return execFileAsync("cmd.exe", ["/c", "start", "", url], {
			windowsHide: true,
		});
	}
	if (process.platform === "darwin") {
		return execFileAsync("open", [url], { windowsHide: true });
	}
	return execFileAsync("xdg-open", [url], { windowsHide: true });
}

async function pickPlayableFile(initialDirectory) {
	if (process.platform !== "win32") {
		throw new Error("当前仅支持 Windows 本机文件选择");
	}

	const safeInitialDirectory = escapePowerShellSingleQuoted(
		path.resolve(initialDirectory || runtimeConfig.defaultSourceDir),
	);
	const script = [
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"$dialog = New-Object System.Windows.Forms.OpenFileDialog",
		`$dialog.InitialDirectory = '${safeInitialDirectory}'`,
		"$dialog.Filter = 'HTML Files (*.html;*.htm)|*.html;*.htm|All Files (*.*)|*.*'",
		"$dialog.Multiselect = $false",
		"$dialog.CheckFileExists = $true",
		"$dialog.CheckPathExists = $true",
		"$owner = New-Object System.Windows.Forms.Form",
		"$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
		"$owner.Size = New-Object System.Drawing.Size(1, 1)",
		"$owner.ShowInTaskbar = $false",
		"$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow",
		"$owner.Opacity = 0",
		"$owner.TopMost = $true",
		"$owner.Show() | Out-Null",
		"$owner.Activate() | Out-Null",
		"$result = $dialog.ShowDialog($owner)",
		"$owner.Close()",
		"$owner.Dispose()",
		"if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }",
	].join("; ");

	const { stdout } = await execFileAsync(
		"powershell.exe",
		["-NoProfile", "-STA", "-Command", script],
		{
			windowsHide: false,
			maxBuffer: 1024 * 1024,
		},
	);
	const filePath = stdout.trim();
	if (!filePath) {
		return null;
	}
	const stat = await fsp.stat(filePath);
	if (!stat.isFile()) {
		throw new Error("选择的目标不是文件");
	}
	return {
		filePath,
		fileName: path.basename(filePath),
		sourceDir: path.dirname(filePath),
	};
}

function normalizeDataUriCandidate(candidate) {
	let value = candidate.trim();
	while (/[;,.]$/.test(value) && !value.endsWith(",")) {
		value = value.slice(0, -1);
	}
	return value;
}

function estimateDataUriSize(dataUri) {
	const commaIndex = dataUri.indexOf(",");
	if (commaIndex === -1) return null;
	const header = dataUri.slice(0, commaIndex).toLowerCase();
	const payload = dataUri.slice(commaIndex + 1);
	try {
		if (header.includes(";base64")) {
			return Buffer.from(payload.replace(/\s+/g, ""), "base64").length;
		}
		return Buffer.byteLength(decodeURIComponent(payload), "utf8");
	} catch {
		return null;
	}
}

function normalizeMimeType(mimeType) {
	return mimeType.replace(/\\\//g, "/").replace(/\s+/g, "").toLowerCase();
}

function extensionForMime(mimeType) {
	const normalized = normalizeMimeType(mimeType);
	return (
		MIME_TO_EXTENSION[normalized] ||
		normalized
			.split("/")
			.pop()
			.replace(/[^a-z0-9]+/gi, "") ||
		"bin"
	);
}

function isSupportedMediaMimeType(mimeType) {
	return /^(image|audio|video)\//.test(mimeType);
}

function hashText(text) {
	return crypto.createHash("sha1").update(text).digest("hex");
}

function mimeTypeFromPath(filePath) {
	const ext = path
		.extname(String(filePath || ""))
		.toLowerCase()
		.slice(1);
	return EXTENSION_TO_MIME[ext] || "";
}

function tryInflateZipEntry(buffer, compressionMethod) {
	if (compressionMethod === 0) {
		return buffer;
	}
	if (compressionMethod === 8) {
		return zlib.inflateRawSync(buffer);
	}
	throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
}

function extractZipEntryBuffer(zipBuffer, entry) {
	const localHeaderOffset = entry.localHeaderOffset;
	if (localHeaderOffset + 30 > zipBuffer.length) {
		throw new Error("ZIP local header out of bounds");
	}
	if (zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
		throw new Error("ZIP local header signature mismatch");
	}
	const fileNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
	const extraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
	const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength;
	const dataEnd = dataStart + entry.compressedSize;
	if (dataEnd > zipBuffer.length) {
		throw new Error("ZIP entry data out of bounds");
	}
	return tryInflateZipEntry(
		zipBuffer.slice(dataStart, dataEnd),
		entry.compressionMethod,
	);
}

function parseCentralDirectoryEntries(zipBuffer) {
	const entries = [];
	let offset = 0;
	while (offset + 46 <= zipBuffer.length) {
		const signature = zipBuffer.readUInt32LE(offset);
		if (signature !== 0x02014b50) {
			offset += 1;
			continue;
		}
		const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
		const compressedSize = zipBuffer.readUInt32LE(offset + 20);
		const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
		const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
		const extraLength = zipBuffer.readUInt16LE(offset + 30);
		const commentLength = zipBuffer.readUInt16LE(offset + 32);
		const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
		const fileNameStart = offset + 46;
		const fileNameEnd = fileNameStart + fileNameLength;
		if (fileNameEnd > zipBuffer.length) {
			break;
		}
		entries.push({
			fileName: zipBuffer
				.slice(fileNameStart, fileNameEnd)
				.toString("utf8"),
			compressionMethod,
			compressedSize,
			uncompressedSize,
			localHeaderOffset,
		});
		offset = fileNameEnd + extraLength + commentLength;
	}
	return entries;
}

function parseLocalHeaderEntries(zipBuffer) {
	const entries = [];
	let offset = 0;
	while (offset + 30 <= zipBuffer.length) {
		const signature = zipBuffer.readUInt32LE(offset);
		if (signature === 0x04034b50) {
			const flags = zipBuffer.readUInt16LE(offset + 6);
			const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
			const compressedSize = zipBuffer.readUInt32LE(offset + 18);
			const uncompressedSize = zipBuffer.readUInt32LE(offset + 22);
			const fileNameLength = zipBuffer.readUInt16LE(offset + 26);
			const extraLength = zipBuffer.readUInt16LE(offset + 28);
			const fileNameStart = offset + 30;
			const fileNameEnd = fileNameStart + fileNameLength;
			const dataStart = fileNameEnd + extraLength;
			const dataEnd = dataStart + compressedSize;

			if (!(flags & 0x08) && dataEnd <= zipBuffer.length) {
				entries.push({
					fileName: zipBuffer
						.slice(fileNameStart, fileNameEnd)
						.toString("utf8"),
					compressionMethod,
					compressedSize,
					uncompressedSize,
					localHeaderOffset: offset,
				});
				offset = dataEnd;
				continue;
			}
		}

		if (signature === 0x02014b50 || signature === 0x06054b50) {
			break;
		}

		offset += 1;
	}
	return entries;
}

function collectMediaFromZipEntries(zipBuffer, entries, sourceLabel) {
	const resources = [];
	const seen = new Set();

	for (const entry of entries) {
		const mimeType = mimeTypeFromPath(entry.fileName);
		if (!mimeType) continue;
		try {
			const fileBuffer = extractZipEntryBuffer(zipBuffer, entry);
			if (
				entry.uncompressedSize &&
				fileBuffer.length !== entry.uncompressedSize
			) {
				continue;
			}
			const dataUri = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
			const resourceId = hashText(dataUri);
			if (seen.has(resourceId)) continue;
			seen.add(resourceId);
			resources.push({
				id: resourceId,
				source: `${sourceLabel}#zip:${entry.fileName}`,
				dataUri,
				mimeType,
				extension: extensionForMime(mimeType),
				sizeBytes: fileBuffer.length,
			});
		} catch {
			// Ignore malformed or unsupported embedded ZIP entries.
		}
	}

	return resources;
}

function extractMediaFromZipBuffer(zipBuffer, sourceLabel) {
	const centralEntries = parseCentralDirectoryEntries(zipBuffer);
	const localEntries = parseLocalHeaderEntries(zipBuffer);
	const centralResources = collectMediaFromZipEntries(
		zipBuffer,
		centralEntries,
		sourceLabel,
	);
	const localResources = collectMediaFromZipEntries(
		zipBuffer,
		localEntries,
		sourceLabel,
	);

	if (centralResources.length === 0) {
		return localResources;
	}
	if (localResources.length === 0) {
		return centralResources;
	}

	return localResources.length > centralResources.length ?
			localResources
		:	centralResources;
}

function trimToZipStart(buffer) {
	for (let index = 0; index <= buffer.length - 4; index += 1) {
		if (buffer.readUInt32LE(index) === 0x04034b50) {
			return buffer.slice(index);
		}
	}
	return null;
}

function isEmbeddedZipCandidateChar(char) {
	return /[A-Za-z0-9+/=\\\s]/.test(char);
}

function extractEmbeddedZipCandidateStrings(text) {
	const candidates = [];
	const seen = new Set();
	const signaturePattern = /UEsDB|QSwM/gi;
	let match;

	while ((match = signaturePattern.exec(text))) {
		const start = match.index;
		let end = match.index + match[0].length;

		while (end < text.length && isEmbeddedZipCandidateChar(text[end])) {
			end += 1;
		}

		const normalized = text
			.slice(start, end)
			.replace(/\\\//g, "/")
			.replace(/[\\\s]+/g, "");
		if (!/^([A-Za-z0-9+/=]+)$/.test(normalized) || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		candidates.push(normalized);
	}

	return candidates;
}

function extractEmbeddedZipResources(text, sourceLabel) {
	const resources = [];
	const seen = new Set();
	for (const normalized of extractEmbeddedZipCandidateStrings(text)) {
		let zipBuffer;
		try {
			zipBuffer = Buffer.from(normalized, "base64");
		} catch {
			continue;
		}
		zipBuffer = trimToZipStart(zipBuffer);
		if (!zipBuffer) {
			continue;
		}
		for (const resource of extractMediaFromZipBuffer(
			zipBuffer,
			sourceLabel,
		)) {
			if (seen.has(resource.id)) continue;
			seen.add(resource.id);
			resources.push(resource);
		}
	}
	return resources;
}

function extractDataUris(text, sourceLabel) {
	const found = [];
	const seen = new Set();
	const registerCandidate = (candidate, mimePart) => {
		const normalized = normalizeDataUriCandidate(candidate);
		const mimeType = normalizeMimeType(mimePart.split(";")[0]);
		if (!mimeType.includes("/") || !isSupportedMediaMimeType(mimeType)) {
			return;
		}
		if (seen.has(normalized)) return;
		seen.add(normalized);
		found.push({
			id: hashText(normalized),
			source: sourceLabel,
			dataUri: normalized,
			mimeType,
			extension: extensionForMime(mimeType),
			sizeBytes: estimateDataUriSize(normalized),
		});
	};

	const base64Pattern =
		/data:((?:image|audio|video)\/[a-z0-9.+-]+(?:;[a-z0-9=:+-]+)*;base64),\s*([a-z0-9+/=\s]+)/gi;
	for (const match of text.matchAll(base64Pattern)) {
		registerCandidate(
			`data:${match[1]},${match[2].replace(/\s+/g, "")}`,
			match[1],
		);
	}

	const plainPattern =
		/data:((?:image|audio|video)\/[a-z0-9.+-]+(?:;[a-z0-9=:+-]+)*),([^"'`<>\[\]{}()\s]+)/gi;
	for (const match of text.matchAll(plainPattern)) {
		registerCandidate(`data:${match[1]},${match[2]}`, match[1]);
	}

	return found;
}

function extractCandidateRefs(text) {
	const refs = new Set();
	const htmlRefPattern = /(?:src|href|poster)=["']([^"']+)["']/gi;
	const jsLiteralPattern =
		/["'`]((?:https?:)?\/\/[^"'`\s]+|(?:\.?\.\/|\/)[^"'`\s]+\.(?:html|htm|js|json|txt|xml|atlas|css|mjs|cjs))(?:\?[^"'`]*)?["'`]/gi;
	const fetchPattern =
		/(?:fetch|importScripts|System\.import|XMLHttpRequest\.open)\s*\([^"'`]*["'`]([^"'`]+)["'`]/gi;

	for (const pattern of [htmlRefPattern, jsLiteralPattern, fetchPattern]) {
		let match;
		while ((match = pattern.exec(text))) {
			refs.add(match[1]);
		}
	}

	return [...refs].filter(Boolean);
}

function isTextLikeResource(resourcePath) {
	const ext = path.extname(resourcePath.split("?")[0]).toLowerCase();
	return TEXT_EXTENSIONS.has(ext);
}

function resolveRef(baseContext, ref, sourceDir) {
	if (!ref) return null;
	const trimmed = ref.trim();
	if (
		!trimmed ||
		trimmed.startsWith("data:") ||
		trimmed.startsWith("blob:") ||
		trimmed.startsWith("javascript:") ||
		trimmed.startsWith("mailto:") ||
		trimmed.startsWith("tel:") ||
		trimmed.startsWith("#")
	) {
		return null;
	}

	if (/^https?:\/\//i.test(trimmed)) {
		return { kind: "remote", value: trimmed };
	}

	if (trimmed.startsWith("//")) {
		return { kind: "remote", value: `https:${trimmed}` };
	}

	if (baseContext.kind === "remote") {
		try {
			return {
				kind: "remote",
				value: new URL(trimmed, baseContext.value).href,
			};
		} catch {
			return null;
		}
	}

	const allowedBase = path.resolve(sourceDir, "..");
	const resolvedLocal =
		trimmed.startsWith("/") ?
			path.resolve(sourceDir, `.${trimmed}`)
		:	path.resolve(path.dirname(baseContext.value), trimmed);

	if (!ensureInside(allowedBase, resolvedLocal)) {
		return null;
	}

	return { kind: "local", value: resolvedLocal };
}

async function readTextFromTarget(target) {
	if (target.kind === "local") {
		return fsp.readFile(target.value, "utf8");
	}

	const response = await fetch(target.value, {
		headers: {
			"user-agent": "PlayableExtractor/1.0",
		},
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}
	return response.text();
}

async function scanPlayable(sourceDir, fileName) {
	const filePath = path.join(sourceDir, fileName);
	const rootTarget = { kind: "local", value: filePath };
	const queue = [{ target: rootTarget, depth: 0 }];
	const visitedTargets = new Set();
	const resources = [];
	const resourceIds = new Set();
	const issues = [];
	const scannedTargets = [];

	while (queue.length > 0) {
		const current = queue.shift();
		const visitKey = `${current.target.kind}:${current.target.value}`;
		if (visitedTargets.has(visitKey)) continue;
		visitedTargets.add(visitKey);

		try {
			const text = await readTextFromTarget(current.target);
			scannedTargets.push(current.target.value);

			for (const resource of extractDataUris(
				text,
				current.target.value,
			)) {
				if (resourceIds.has(resource.id)) continue;
				resourceIds.add(resource.id);
				resources.push(resource);
			}

			for (const resource of extractEmbeddedZipResources(
				text,
				current.target.value,
			)) {
				if (resourceIds.has(resource.id)) continue;
				resourceIds.add(resource.id);
				resources.push(resource);
			}

			if (current.depth >= MAX_SCAN_DEPTH) {
				continue;
			}

			for (const ref of extractCandidateRefs(text)) {
				const resolved = resolveRef(current.target, ref, sourceDir);
				if (!resolved) continue;
				if (
					resolved.kind === "local" &&
					!isTextLikeResource(resolved.value)
				) {
					continue;
				}
				if (resolved.kind === "remote") {
					const remotePath = new URL(resolved.value).pathname;
					if (!isTextLikeResource(remotePath)) continue;
				}
				queue.push({ target: resolved, depth: current.depth + 1 });
			}
		} catch (error) {
			issues.push({
				target: current.target.value,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		fileName,
		scannedTargets,
		issues,
		resources,
	};
}

function runtimeCollectorInstaller(collectorContext) {
	if (window.__playableExtractorInstalled) {
		return;
	}

	window.__playableExtractorInstalled = true;
	window.__playableExtractorInstall = runtimeCollectorInstaller;
	window.__playableExtractorInstallSource =
		runtimeCollectorInstaller.toString();
	window.__playableExtractorCollectorContext = collectorContext;
	const shouldCollectRuntimeResources =
		collectorContext?.collectRuntimeResources !== false;

	const seen = new Set();
	const isDataUri = (value) =>
		typeof value === "string" && value.startsWith("data:");
	const extractInlineDataUris = (text) => {
		if (typeof text !== "string") return [];
		const matches = [];
		const seenMatches = new Set();
		const base64Pattern =
			/data:((?:image|audio|video)\/[a-z0-9.+-]+(?:;[a-z0-9=:+-]+)*;base64),\s*([a-z0-9+/=\s]+)/gi;
		for (const match of text.matchAll(base64Pattern)) {
			const normalized =
				"data:" + match[1] + "," + match[2].replace(/\s+/g, "");
			if (!seenMatches.has(normalized)) {
				seenMatches.add(normalized);
				matches.push(normalized);
			}
		}
		const plainPattern =
			/data:((?:image|audio|video)\/[a-z0-9.+-]+(?:;[a-z0-9=:+-]+)*),([^"'`<>\[\]{}()\s]+)/gi;
		for (const match of text.matchAll(plainPattern)) {
			const normalized = "data:" + match[1] + "," + match[2];
			if (!seenMatches.has(normalized)) {
				seenMatches.add(normalized);
				matches.push(normalized);
			}
		}
		return matches;
	};
	const normalizeWindowsPath = (value) =>
		String(value || "").replace(/\\/g, "/");
	const stripDrive = (value) =>
		normalizeWindowsPath(value).replace(/^[a-z]:/i, "");
	const joinPathSegments = (parts) => {
		const output = [];
		for (const part of parts) {
			if (!part || part === ".") continue;
			if (part === "..") {
				output.pop();
				continue;
			}
			output.push(part);
		}
		return output;
	};
	const resolveLocalFile = (value) => {
		if (!collectorContext?.localFilePath || !collectorContext?.sourceDir) {
			return null;
		}
		if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) {
			return null;
		}
		if (/^[a-z]+:/i.test(value) || value.startsWith("//")) {
			return null;
		}

		const sourceDir = normalizeWindowsPath(collectorContext.sourceDir);
		const localFilePath = normalizeWindowsPath(
			collectorContext.localFilePath,
		);
		const driveMatch = /^[a-z]:/i.exec(localFilePath);
		const drivePrefix = driveMatch ? driveMatch[0] : "";
		const sourceSegments = stripDrive(sourceDir).split("/").filter(Boolean);
		const baseSegments = stripDrive(localFilePath)
			.split("/")
			.filter(Boolean);
		baseSegments.pop();
		const inputSegments = value.split("/").filter(Boolean);
		const resolvedSegments =
			value.startsWith("/") ?
				joinPathSegments([...sourceSegments, ...inputSegments])
			:	joinPathSegments([...baseSegments, ...inputSegments]);
		return `${drivePrefix}/${resolvedSegments.join("/")}`;
	};
	const proxifyUrl = (value) => {
		if (typeof value !== "string") return value;
		if (/^https?:\/\//i.test(value)) {
			return (
				"/proxy?entryFileName=" +
				encodeURIComponent(collectorContext?.entryFileName || "") +
				"&url=" +
				encodeURIComponent(value)
			);
		}
		if (value.startsWith("//")) {
			return (
				"/proxy?entryFileName=" +
				encodeURIComponent(collectorContext?.entryFileName || "") +
				"&url=" +
				encodeURIComponent("https:" + value)
			);
		}

		const localFile = resolveLocalFile(value);
		if (localFile) {
			return (
				"/local-asset?entryFileName=" +
				encodeURIComponent(collectorContext?.entryFileName || "") +
				"&sourceDir=" +
				encodeURIComponent(collectorContext.sourceDir) +
				"&file=" +
				encodeURIComponent(localFile)
			);
		}

		if (collectorContext?.remoteUrl) {
			try {
				return (
					"/proxy?entryFileName=" +
					encodeURIComponent(collectorContext?.entryFileName || "") +
					"&url=" +
					encodeURIComponent(
						new URL(value, collectorContext.remoteUrl).href,
					)
				);
			} catch (error) {
				console.warn("relative remote URL resolution failed", error);
			}
		}

		return value;
	};
	const forwardUp = (message) => {
		try {
			if (window.parent && window.parent !== window) {
				window.parent.postMessage(message, "*");
			}
		} catch (error) {
			console.warn("postMessage failed", error);
		}
	};
	const post = (type, payload) => {
		forwardUp({
			source: "playable-extractor",
			type,
			payload: {
				entryFileName: collectorContext?.entryFileName || null,
				...payload,
			},
		});
	};
	const isMediaMimeType = (value) => {
		const mimeType = String(value || "")
			.split(";")[0]
			.trim()
			.toLowerCase();
		return /^(image|audio|video)\//.test(mimeType);
	};
	const mimeTypeFromFileName = (fileName) => {
		const value = String(fileName || "").toLowerCase();
		if (value.endsWith(".png")) return "image/png";
		if (value.endsWith(".jpg") || value.endsWith(".jpeg")) {
			return "image/jpeg";
		}
		if (value.endsWith(".webp")) return "image/webp";
		if (value.endsWith(".gif")) return "image/gif";
		if (value.endsWith(".avif")) return "image/avif";
		if (value.endsWith(".svg")) return "image/svg+xml";
		if (value.endsWith(".mp3")) return "audio/mpeg";
		if (value.endsWith(".ogg")) return "audio/ogg";
		if (value.endsWith(".wav")) return "audio/wav";
		if (value.endsWith(".webm")) return "video/webm";
		if (value.endsWith(".mp4")) return "video/mp4";
		return "";
	};
	const report = (value, channel) => {
		if (!isDataUri(value) || seen.has(value)) return;
		seen.add(value);
		post("resource", { dataUri: value, channel: channel || "runtime" });
	};
	const reportInlineDataUris = (text, channel) => {
		for (const match of extractInlineDataUris(text)) {
			report(match, channel);
		}
	};
	const reportBlob = (blob, channel) => {
		if (!(blob instanceof Blob)) return;
		const reader = new FileReader();
		reader.onload = () => report(reader.result, channel);
		reader.onerror = () => {};
		reader.readAsDataURL(blob);
	};
	const reportBinary = (value, mimeType, channel) => {
		if (!mimeType || !isMediaMimeType(mimeType)) return;
		if (value instanceof Blob) {
			reportBlob(
				value.type ? value : new Blob([value], { type: mimeType }),
				channel,
			);
			return;
		}
		if (value instanceof ArrayBuffer) {
			reportBlob(new Blob([value], { type: mimeType }), channel);
			return;
		}
		if (ArrayBuffer.isView(value)) {
			reportBlob(new Blob([value], { type: mimeType }), channel);
		}
	};
	const resolveMediaMimeHint = (contentType, urlValue) => {
		const headerMimeType = String(contentType || "")
			.split(";")[0]
			.trim()
			.toLowerCase();
		if (isMediaMimeType(headerMimeType)) {
			return headerMimeType;
		}
		return mimeTypeFromFileName(urlValue);
	};
	const reportCanvas = (canvas, channel) => {
		try {
			if (canvas && typeof canvas.toDataURL === "function") {
				report(canvas.toDataURL("image/png"), channel);
			}
		} catch (error) {
			console.warn("canvas scan failed", error);
		}
	};
	const reportImageElement = (image, channel) => {
		if (!(image instanceof HTMLImageElement)) return;
		const src = image.currentSrc || image.src || "";
		if (isDataUri(src)) {
			report(src, channel);
			return;
		}
		const width = image.naturalWidth || image.width || 0;
		const height = image.naturalHeight || image.height || 0;
		if (!width || !height || image.__playableExtractorSnapshotting) {
			return;
		}
		try {
			image.__playableExtractorSnapshotting = true;
			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			ctx.drawImage(image, 0, 0, width, height);
			report(canvas.toDataURL("image/png"), channel);
		} catch (error) {
			console.warn("image snapshot failed", error);
		} finally {
			image.__playableExtractorSnapshotting = false;
		}
	};
	const injectCollectorIntoDocument = (doc, nextContext) => {
		try {
			if (
				!doc?.defaultView ||
				doc.defaultView.__playableExtractorInstalled
			) {
				return;
			}
			const script = doc.createElement("script");
			const serializedContext = JSON.stringify(nextContext).replace(
				/</g,
				"\\u003c",
			);
			script.textContent =
				"(" +
				window.__playableExtractorInstallSource +
				")(" +
				serializedContext +
				");";
			(doc.head || doc.documentElement || doc.body).appendChild(script);
			script.remove();
		} catch (error) {
			console.warn("iframe injection failed", error);
		}
	};
	const getContextFromFrame = (frame) => {
		const src = frame?.getAttribute("src") || frame?.src || "";
		try {
			const parsed = new URL(src, window.location.href);
			if (parsed.origin !== window.location.origin) {
				return collectorContext;
			}
			if (parsed.pathname === "/local-asset") {
				return {
					entryFileName:
						parsed.searchParams.get("entryFileName") ||
						collectorContext?.entryFileName ||
						null,
					sourceDir:
						parsed.searchParams.get("sourceDir") ||
						collectorContext?.sourceDir ||
						null,
					localFilePath: parsed.searchParams.get("file"),
					collectRuntimeResources: shouldCollectRuntimeResources,
					remoteUrl: null,
				};
			}
			if (parsed.pathname === "/proxy") {
				return {
					entryFileName:
						parsed.searchParams.get("entryFileName") ||
						collectorContext?.entryFileName ||
						null,
					sourceDir: null,
					localFilePath: null,
					collectRuntimeResources: shouldCollectRuntimeResources,
					remoteUrl: parsed.searchParams.get("url"),
				};
			}
		} catch (error) {
			console.warn("frame context parse failed", error);
		}
		return collectorContext;
	};
	const installIntoFrame = (frame) => {
		if (!frame || frame.__playableExtractorFrameHooked) return;
		frame.__playableExtractorFrameHooked = true;
		const install = () => {
			try {
				injectCollectorIntoDocument(
					frame.contentDocument,
					getContextFromFrame(frame),
				);
			} catch (error) {
				console.warn("frame install failed", error);
			}
		};
		frame.addEventListener("load", install);
		install();
	};
	const wrapSetter = (Ctor, property, channel, rewriter) => {
		if (!Ctor?.prototype) return;
		const descriptor = Object.getOwnPropertyDescriptor(
			Ctor.prototype,
			property,
		);
		if (!descriptor?.set || !descriptor?.get) return;
		Object.defineProperty(Ctor.prototype, property, {
			configurable: true,
			enumerable: descriptor.enumerable,
			get: descriptor.get,
			set(value) {
				if (typeof value === "string") {
					report(value, channel);
				}
				const nextValue = rewriter ? rewriter.call(this, value) : value;
				return descriptor.set.call(this, nextValue);
			},
		});
	};
	const wrapStringSetter = (Ctor, property, channel, handler) => {
		if (!Ctor?.prototype) return;
		const descriptor = Object.getOwnPropertyDescriptor(
			Ctor.prototype,
			property,
		);
		if (!descriptor?.set || !descriptor?.get) return;
		Object.defineProperty(Ctor.prototype, property, {
			configurable: true,
			enumerable: descriptor.enumerable,
			get: descriptor.get,
			set(value) {
				if (typeof value === "string") {
					handler(value, channel);
				}
				return descriptor.set.call(this, value);
			},
		});
	};
	const wrapJsZipFileObject = (zipEntry) => {
		if (!zipEntry || zipEntry.__playableExtractorWrappedZipEntry) return;
		const fileName = zipEntry.name || zipEntry.unsafeOriginalName || "";
		const mimeType = mimeTypeFromFileName(fileName);
		if (!mimeType) return;
		zipEntry.__playableExtractorWrappedZipEntry = true;
		if (typeof zipEntry.async === "function") {
			const originalAsync = zipEntry.async;
			zipEntry.async = function (...args) {
				return originalAsync.apply(this, args).then((result) => {
					reportBinary(result, mimeType, `jszip.async:${fileName}`);
					return result;
				});
			};
		}
	};
	const wrapJsZipArchive = (zip) => {
		if (!zip || zip.__playableExtractorWrappedZip) return zip;
		zip.__playableExtractorWrappedZip = true;
		for (const entry of Object.values(zip.files || {})) {
			wrapJsZipFileObject(entry);
		}
		if (typeof zip.file === "function") {
			const originalFile = zip.file;
			zip.file = function (...args) {
				const result = originalFile.apply(this, args);
				if (Array.isArray(result)) {
					for (const entry of result) {
						wrapJsZipFileObject(entry);
					}
				} else {
					wrapJsZipFileObject(result);
				}
				return result;
			};
		}
		return zip;
	};
	const installJsZipHooks = () => {
		const JSZipCtor = window.JSZip;
		if (!JSZipCtor || JSZipCtor.__playableExtractorWrapped) return;
		JSZipCtor.__playableExtractorWrapped = true;
		if (typeof JSZipCtor.loadAsync === "function") {
			const originalStaticLoadAsync = JSZipCtor.loadAsync;
			JSZipCtor.loadAsync = function (...args) {
				return originalStaticLoadAsync.apply(this, args).then((zip) => {
					wrapJsZipArchive(zip);
					return zip;
				});
			};
		}
		if (typeof JSZipCtor.prototype?.loadAsync === "function") {
			const originalPrototypeLoadAsync = JSZipCtor.prototype.loadAsync;
			JSZipCtor.prototype.loadAsync = function (...args) {
				return originalPrototypeLoadAsync
					.apply(this, args)
					.then((zip) => {
						wrapJsZipArchive(zip);
						return zip;
					});
			};
		}
	};

	window.addEventListener("message", (event) => {
		if (event.data?.source === "playable-extractor") {
			forwardUp(event.data);
		}
	});

	wrapSetter(HTMLImageElement, "src", "img.src", proxifyUrl);
	wrapSetter(HTMLAudioElement, "src", "audio.src", proxifyUrl);
	wrapSetter(HTMLVideoElement, "src", "video.src", proxifyUrl);
	wrapSetter(HTMLSourceElement, "src", "source.src", proxifyUrl);
	wrapSetter(HTMLScriptElement, "src", "script.src", proxifyUrl);
	wrapSetter(HTMLIFrameElement, "src", "iframe.src", proxifyUrl);
	wrapStringSetter(
		HTMLIFrameElement,
		"srcdoc",
		"iframe.srcdoc",
		reportInlineDataUris,
	);

	if (
		typeof URL !== "undefined" &&
		typeof URL.createObjectURL === "function"
	) {
		const originalCreateObjectURL = URL.createObjectURL.bind(URL);
		URL.createObjectURL = function (object) {
			const objectUrl = originalCreateObjectURL(object);
			if (object instanceof Blob) {
				reportBlob(object, "url.createObjectURL");
			}
			return objectUrl;
		};
	}

	const originalFetch = window.fetch;
	if (originalFetch) {
		window.fetch = function (...args) {
			const candidate = args[0];
			if (typeof candidate === "string") report(candidate, "fetch");
			else if (candidate && typeof candidate.url === "string") {
				report(candidate.url, "fetch");
			}

			const proxiedArgs = [...args];
			if (typeof candidate === "string") {
				proxiedArgs[0] = proxifyUrl(candidate);
			} else if (candidate instanceof URL) {
				proxiedArgs[0] = proxifyUrl(candidate.href);
			} else if (
				typeof Request !== "undefined" &&
				candidate instanceof Request &&
				typeof candidate.url === "string"
			) {
				proxiedArgs[0] = new Request(
					proxifyUrl(candidate.url),
					candidate,
				);
			}

			return originalFetch
				.apply(this, proxiedArgs)
				.then(async (response) => {
					const contentType =
						response.headers.get("content-type") || "";
					const mediaMimeType = resolveMediaMimeHint(
						contentType,
						response.url ||
							(typeof candidate === "string" ? candidate : (
								candidate?.url
							)),
					);
					if (mediaMimeType) {
						try {
							reportBlob(
								new Blob(
									[await response.clone().arrayBuffer()],
									{
										type: mediaMimeType,
									},
								),
								"fetch-response-media",
							);
						} catch (error) {
							console.warn("fetch media clone failed", error);
						}
					} else if (/json|javascript|text|xml/.test(contentType)) {
						try {
							const text = await response.clone().text();
							reportInlineDataUris(text, "fetch-response");
						} catch (error) {
							console.warn("fetch clone scan failed", error);
						}
					}
					return response;
				});
		};
	}

	const originalOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url, ...rest) {
		if (typeof url === "string") report(url, "xhr.open");
		const proxiedUrl = typeof url === "string" ? proxifyUrl(url) : url;
		this.addEventListener("load", function () {
			try {
				const contentType =
					this.getResponseHeader("content-type") || "";
				const mediaMimeType = resolveMediaMimeHint(
					contentType,
					this.responseURL || (typeof url === "string" ? url : ""),
				);
				if (mediaMimeType) {
					if (this.response instanceof Blob) {
						reportBlob(
							this.response.type ?
								this.response
							:	new Blob([this.response], { type: mediaMimeType }),
							"xhr-response-media",
						);
					} else if (this.response instanceof ArrayBuffer) {
						reportBlob(
							new Blob([this.response], { type: mediaMimeType }),
							"xhr-response-media",
						);
					}
				} else if (typeof this.responseText === "string") {
					reportInlineDataUris(this.responseText, "xhr-response");
				}
			} catch (error) {
				console.warn("xhr scan failed", error);
			}
		});
		return originalOpen.call(this, method, proxiedUrl, ...rest);
	};

	const originalDrawImage = CanvasRenderingContext2D?.prototype?.drawImage;
	if (originalDrawImage) {
		CanvasRenderingContext2D.prototype.drawImage = function (...args) {
			const source = args[0];
			if (source instanceof HTMLImageElement) {
				reportImageElement(source, "canvas.drawImage:img");
			} else if (source instanceof HTMLCanvasElement) {
				reportCanvas(source, "canvas.drawImage:canvas");
			} else if (
				typeof ImageBitmap !== "undefined" &&
				source instanceof ImageBitmap
			) {
				reportCanvas(this.canvas, "canvas.drawImage:imageBitmap");
			}
			return originalDrawImage.apply(this, args);
		};
	}

	const originalToDataURL = HTMLCanvasElement?.prototype?.toDataURL;
	if (originalToDataURL) {
		HTMLCanvasElement.prototype.toDataURL = function (...args) {
			const value = originalToDataURL.apply(this, args);
			report(value, "canvas.toDataURL");
			return value;
		};
	}

	const originalToBlob = HTMLCanvasElement?.prototype?.toBlob;
	if (originalToBlob) {
		HTMLCanvasElement.prototype.toBlob = function (
			callback,
			type,
			quality,
		) {
			return originalToBlob.call(
				this,
				(blob) => {
					reportBlob(blob, "canvas.toBlob");
					if (typeof callback === "function") {
						callback(blob);
					}
				},
				type,
				quality,
			);
		};
	}

	if (
		typeof OffscreenCanvas !== "undefined" &&
		OffscreenCanvas.prototype.convertToBlob
	) {
		const originalConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
		OffscreenCanvas.prototype.convertToBlob = function (...args) {
			return originalConvertToBlob.apply(this, args).then((blob) => {
				reportBlob(blob, "offscreenCanvas.convertToBlob");
				return blob;
			});
		};
	}

	let previewFitRafId = 0;
	const previewFitTimers = new Set();
	const applyPreviewAutoFit = () => {
		const html = document.documentElement;
		const body = document.body;
		if (!html || !body) {
			return;
		}

		html.dataset.playablePreviewAutofit = "1";
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
		const viewportWidth =
			window.innerWidth || html.clientWidth || naturalWidth;
		const viewportHeight =
			window.innerHeight || html.clientHeight || naturalHeight;
		const scale = Math.min(
			1,
			naturalWidth > 0 ? viewportWidth / naturalWidth : 1,
			naturalHeight > 0 ? viewportHeight / naturalHeight : 1,
		);

		body.style.width = `${naturalWidth}px`;
		body.style.height = `${naturalHeight}px`;
		body.style.transformOrigin = "top left";
		body.style.transform = `scale(${scale})`;
		body.dataset.playablePreviewScale = String(scale);
	};
	const schedulePreviewAutoFit = () => {
		if (previewFitRafId) {
			cancelAnimationFrame(previewFitRafId);
		}
		for (const timerId of previewFitTimers) {
			clearTimeout(timerId);
		}
		previewFitTimers.clear();

		previewFitRafId = requestAnimationFrame(() => {
			previewFitRafId = 0;
			applyPreviewAutoFit();
		});

		for (const delay of [120, 500, 1400, 2800]) {
			const timerId = setTimeout(() => {
				previewFitTimers.delete(timerId);
				applyPreviewAutoFit();
			}, delay);
			previewFitTimers.add(timerId);
		}
	};
	window.addEventListener("resize", schedulePreviewAutoFit);

	const inspectNode = (node) => {
		if (!node || node.nodeType !== 1) return;
		for (const attribute of ["src", "href", "poster"]) {
			const value = node.getAttribute && node.getAttribute(attribute);
			report(value, `attr:${attribute}`);
		}
		if (node.style) {
			reportInlineDataUris(node.getAttribute("style") || "", "style");
		}
		if (node.tagName === "IFRAME") {
			reportInlineDataUris(
				node.getAttribute("srcdoc") || "",
				"iframe.srcdoc-attr",
			);
			installIntoFrame(node);
		}
		if (node.tagName === "SCRIPT") {
			reportInlineDataUris(node.textContent || "", "script.text");
		}
		if (node.tagName === "IMG") {
			reportImageElement(node, "img.element");
		}
		if (node.tagName === "CANVAS") {
			reportCanvas(node, "canvas.element");
		}
		if (node.querySelectorAll) {
			for (const child of node.querySelectorAll(
				"[src],[href],[poster],[style],iframe,canvas,img,script",
			)) {
				if (child.tagName === "IFRAME") installIntoFrame(child);
				if (child.tagName === "SCRIPT")
					reportInlineDataUris(
						child.textContent || "",
						"script.scan",
					);
				if (child.tagName === "IMG")
					reportImageElement(child, "img.scan");
				if (child.tagName === "CANVAS")
					reportCanvas(child, "canvas.scan");
				inspectNode(child);
			}
		}
	};

	document.addEventListener(
		"load",
		(event) => {
			if (event.target instanceof HTMLImageElement) {
				reportImageElement(event.target, "img.load");
			}
		},
		true,
	);

	new MutationObserver((entries) => {
		for (const entry of entries) {
			if (entry.type === "attributes") {
				inspectNode(entry.target);
			}
			for (const node of entry.addedNodes) {
				inspectNode(node);
			}
		}
		schedulePreviewAutoFit();
	}).observe(document.documentElement || document, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: ["src", "href", "poster", "style"],
	});

	const scanDocument = () => {
		inspectNode(document.documentElement);
		for (const canvas of document.querySelectorAll("canvas")) {
			reportCanvas(canvas, "canvas.periodic");
		}
		for (const frame of document.querySelectorAll("iframe")) {
			installIntoFrame(frame);
		}
	};
	const announceReady = () => {
		installJsZipHooks();
		scanDocument();
		schedulePreviewAutoFit();
		setTimeout(scanDocument, 400);
		setTimeout(scanDocument, 1400);
		setTimeout(installJsZipHooks, 400);
		setTimeout(installJsZipHooks, 1400);
		setTimeout(installJsZipHooks, 3000);
		post("status", { ready: true, title: document.title || "" });
	};

	if (document.readyState === "loading") {
		window.addEventListener("DOMContentLoaded", announceReady, {
			once: true,
		});
	} else {
		announceReady();
	}
}

function previewRuntimeInstaller(collectorContext) {
	if (window.__playableExtractorInstalled) {
		return;
	}

	window.__playableExtractorInstalled = true;
	window.__playableExtractorInstall = previewRuntimeInstaller;
	window.__playableExtractorInstallSource =
		previewRuntimeInstaller.toString();
	window.__playableExtractorCollectorContext = collectorContext;

	const normalizeWindowsPath = (value) =>
		String(value || "").replace(/\\/g, "/");
	const stripDrive = (value) =>
		normalizeWindowsPath(value).replace(/^[a-z]:/i, "");
	const joinPathSegments = (parts) => {
		const output = [];
		for (const part of parts) {
			if (!part || part === ".") continue;
			if (part === "..") {
				output.pop();
				continue;
			}
			output.push(part);
		}
		return output;
	};
	const resolveLocalFile = (value) => {
		if (!collectorContext?.localFilePath || !collectorContext?.sourceDir) {
			return null;
		}
		if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) {
			return null;
		}
		if (/^[a-z]+:/i.test(value) || value.startsWith("//")) {
			return null;
		}

		const sourceDir = normalizeWindowsPath(collectorContext.sourceDir);
		const localFilePath = normalizeWindowsPath(
			collectorContext.localFilePath,
		);
		const driveMatch = /^[a-z]:/i.exec(localFilePath);
		const drivePrefix = driveMatch ? driveMatch[0] : "";
		const sourceSegments = stripDrive(sourceDir).split("/").filter(Boolean);
		const baseSegments = stripDrive(localFilePath)
			.split("/")
			.filter(Boolean);
		baseSegments.pop();
		const inputSegments = value.split("/").filter(Boolean);
		const resolvedSegments =
			value.startsWith("/") ?
				joinPathSegments([...sourceSegments, ...inputSegments])
			:	joinPathSegments([...baseSegments, ...inputSegments]);
		return `${drivePrefix}/${resolvedSegments.join("/")}`;
	};
	const proxifyUrl = (value) => {
		if (typeof value !== "string") return value;
		if (/^https?:\/\//i.test(value)) {
			return (
				"/proxy?entryFileName=" +
				encodeURIComponent(collectorContext?.entryFileName || "") +
				"&collectRuntime=0&url=" +
				encodeURIComponent(value)
			);
		}
		if (value.startsWith("//")) {
			return (
				"/proxy?entryFileName=" +
				encodeURIComponent(collectorContext?.entryFileName || "") +
				"&collectRuntime=0&url=" +
				encodeURIComponent("https:" + value)
			);
		}

		const localFile = resolveLocalFile(value);
		if (localFile) {
			return (
				"/local-asset?entryFileName=" +
				encodeURIComponent(collectorContext?.entryFileName || "") +
				"&collectRuntime=0&sourceDir=" +
				encodeURIComponent(collectorContext.sourceDir) +
				"&file=" +
				encodeURIComponent(localFile)
			);
		}

		if (collectorContext?.remoteUrl) {
			try {
				return (
					"/proxy?entryFileName=" +
					encodeURIComponent(collectorContext?.entryFileName || "") +
					"&collectRuntime=0&url=" +
					encodeURIComponent(
						new URL(value, collectorContext.remoteUrl).href,
					)
				);
			} catch (error) {
				console.warn("relative remote URL resolution failed", error);
			}
		}

		return value;
	};
	const forwardUp = (message) => {
		try {
			if (window.parent && window.parent !== window) {
				window.parent.postMessage(message, "*");
			}
		} catch (error) {
			console.warn("postMessage failed", error);
		}
	};
	const post = (type, payload) => {
		forwardUp({
			source: "playable-extractor",
			type,
			payload: {
				entryFileName: collectorContext?.entryFileName || null,
				...payload,
			},
		});
	};
	const getContextFromFrame = (frame) => {
		const src = frame?.getAttribute("src") || frame?.src || "";
		try {
			const parsed = new URL(src, window.location.href);
			if (parsed.origin !== window.location.origin) {
				return collectorContext;
			}
			if (parsed.pathname === "/local-asset") {
				return {
					entryFileName:
						parsed.searchParams.get("entryFileName") ||
						collectorContext?.entryFileName ||
						null,
					sourceDir:
						parsed.searchParams.get("sourceDir") ||
						collectorContext?.sourceDir ||
						null,
					localFilePath: parsed.searchParams.get("file"),
					collectRuntimeResources: false,
					remoteUrl: null,
				};
			}
			if (parsed.pathname === "/proxy") {
				return {
					entryFileName:
						parsed.searchParams.get("entryFileName") ||
						collectorContext?.entryFileName ||
						null,
					sourceDir: null,
					localFilePath: null,
					collectRuntimeResources: false,
					remoteUrl: parsed.searchParams.get("url"),
				};
			}
		} catch (error) {
			console.warn("frame context parse failed", error);
		}
		return collectorContext;
	};
	const injectInstallerIntoDocument = (doc, nextContext) => {
		try {
			if (
				!doc?.defaultView ||
				doc.defaultView.__playableExtractorInstalled
			) {
				return;
			}
			const script = doc.createElement("script");
			const serializedContext = JSON.stringify(nextContext).replace(
				/</g,
				"\\u003c",
			);
			script.textContent =
				"(" +
				window.__playableExtractorInstallSource +
				")(" +
				serializedContext +
				");";
			(doc.head || doc.documentElement || doc.body).appendChild(script);
			script.remove();
		} catch (error) {
			console.warn("iframe injection failed", error);
		}
	};
	const installIntoFrame = (frame) => {
		if (!frame || frame.__playableExtractorFrameHooked) return;
		frame.__playableExtractorFrameHooked = true;
		const install = () => {
			try {
				injectInstallerIntoDocument(
					frame.contentDocument,
					getContextFromFrame(frame),
				);
			} catch (error) {
				console.warn("frame install failed", error);
			}
		};
		frame.addEventListener("load", install);
		install();
	};
	const wrapSetter = (Ctor, property, rewriter) => {
		if (!Ctor?.prototype) return;
		const descriptor = Object.getOwnPropertyDescriptor(
			Ctor.prototype,
			property,
		);
		if (!descriptor?.set || !descriptor?.get) return;
		Object.defineProperty(Ctor.prototype, property, {
			configurable: true,
			enumerable: descriptor.enumerable,
			get: descriptor.get,
			set(value) {
				const nextValue = rewriter ? rewriter.call(this, value) : value;
				return descriptor.set.call(this, nextValue);
			},
		});
	};

	window.addEventListener("message", (event) => {
		if (event.data?.source === "playable-extractor") {
			forwardUp(event.data);
		}
	});

	wrapSetter(HTMLImageElement, "src", proxifyUrl);
	wrapSetter(HTMLAudioElement, "src", proxifyUrl);
	wrapSetter(HTMLVideoElement, "src", proxifyUrl);
	wrapSetter(HTMLSourceElement, "src", proxifyUrl);
	wrapSetter(HTMLScriptElement, "src", proxifyUrl);
	wrapSetter(HTMLIFrameElement, "src", proxifyUrl);

	const originalFetch = window.fetch;
	if (originalFetch) {
		window.fetch = function (...args) {
			const candidate = args[0];
			const proxiedArgs = [...args];
			if (typeof candidate === "string") {
				proxiedArgs[0] = proxifyUrl(candidate);
			} else if (candidate instanceof URL) {
				proxiedArgs[0] = proxifyUrl(candidate.href);
			} else if (
				typeof Request !== "undefined" &&
				candidate instanceof Request &&
				typeof candidate.url === "string"
			) {
				proxiedArgs[0] = new Request(
					proxifyUrl(candidate.url),
					candidate,
				);
			}
			return originalFetch.apply(this, proxiedArgs);
		};
	}

	const originalOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url, ...rest) {
		const proxiedUrl = typeof url === "string" ? proxifyUrl(url) : url;
		return originalOpen.call(this, method, proxiedUrl, ...rest);
	};

	let previewFitRafId = 0;
	const previewFitTimers = new Set();
	const applyPreviewAutoFit = () => {
		const html = document.documentElement;
		const body = document.body;
		if (!html || !body) {
			return;
		}

		html.dataset.playablePreviewAutofit = "1";
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
		const viewportWidth =
			window.innerWidth || html.clientWidth || naturalWidth;
		const viewportHeight =
			window.innerHeight || html.clientHeight || naturalHeight;
		const scale = Math.min(
			1,
			naturalWidth > 0 ? viewportWidth / naturalWidth : 1,
			naturalHeight > 0 ? viewportHeight / naturalHeight : 1,
		);

		body.style.width = `${naturalWidth}px`;
		body.style.height = `${naturalHeight}px`;
		body.style.transformOrigin = "top left";
		body.style.transform = `scale(${scale})`;
		body.dataset.playablePreviewScale = String(scale);
	};
	const schedulePreviewAutoFit = () => {
		if (previewFitRafId) {
			cancelAnimationFrame(previewFitRafId);
		}
		for (const timerId of previewFitTimers) {
			clearTimeout(timerId);
		}
		previewFitTimers.clear();

		previewFitRafId = requestAnimationFrame(() => {
			previewFitRafId = 0;
			applyPreviewAutoFit();
		});

		for (const delay of [120, 500, 1400, 2800]) {
			const timerId = setTimeout(() => {
				previewFitTimers.delete(timerId);
				applyPreviewAutoFit();
			}, delay);
			previewFitTimers.add(timerId);
		}
	};
	window.addEventListener("resize", schedulePreviewAutoFit);

	new MutationObserver(() => {
		for (const frame of document.querySelectorAll("iframe")) {
			installIntoFrame(frame);
		}
		schedulePreviewAutoFit();
	}).observe(document.documentElement || document, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: ["src", "href", "poster", "style"],
	});

	const announceReady = () => {
		for (const frame of document.querySelectorAll("iframe")) {
			installIntoFrame(frame);
		}
		schedulePreviewAutoFit();
		setTimeout(schedulePreviewAutoFit, 400);
		setTimeout(schedulePreviewAutoFit, 1400);
		post("status", { ready: true, title: document.title || "" });
	};

	if (document.readyState === "loading") {
		window.addEventListener("DOMContentLoaded", announceReady, {
			once: true,
		});
	} else {
		announceReady();
	}
}

function buildRuntimeCollectorScript(context) {
	const installer =
		context?.collectRuntimeResources === false ?
			previewRuntimeInstaller
		:	runtimeCollectorInstaller;
	return `<script>(${installer.toString()})(${JSON.stringify(context).replace(/</g, "\\u003c")});</script>`;
}

function decodeHtmlAttribute(value) {
	return String(value || "")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function encodeHtmlAttribute(value) {
	return String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function rewriteDocumentAssetUrl(value, context) {
	if (
		!value ||
		value.startsWith("data:") ||
		value.startsWith("javascript:") ||
		value.startsWith("mailto:") ||
		value.startsWith("tel:") ||
		value.startsWith("#")
	) {
		return null;
	}

	if (/^https?:\/\//i.test(value) || value.startsWith("//")) {
		const targetUrl = value.startsWith("//") ? `https:${value}` : value;
		return `/proxy?entryFileName=${encodeURIComponent(context.entryFileName || "")}&url=${encodeURIComponent(targetUrl)}`;
	}

	if (context.remoteUrl) {
		try {
			return `/proxy?entryFileName=${encodeURIComponent(context.entryFileName || "")}&url=${encodeURIComponent(new URL(value, context.remoteUrl).href)}`;
		} catch {
			return null;
		}
	}

	if (!context.localFilePath || !context.sourceDir) {
		return null;
	}

	const allowedBase = path.resolve(context.sourceDir, "..");
	const resolved =
		value.startsWith("/") ?
			path.resolve(context.sourceDir, `.${value}`)
		:	path.resolve(path.dirname(context.localFilePath), value);

	if (!ensureInside(allowedBase, resolved)) {
		return null;
	}

	return `/local-asset?entryFileName=${encodeURIComponent(context.entryFileName || "")}&sourceDir=${encodeURIComponent(context.sourceDir)}&file=${encodeURIComponent(resolved)}`;
}

function rewriteHtmlDocument(html, context) {
	const srcdocInjected = html.replace(
		/srcdoc=("|')([\s\S]*?)(\1)/gi,
		(full, quote, value) => {
			const decoded = decodeHtmlAttribute(value);
			const rewritten = rewriteHtmlDocument(decoded, context);
			return `srcdoc=${quote}${encodeHtmlAttribute(rewritten)}${quote}`;
		},
	);

	const injected =
		srcdocInjected.includes("</head>") ?
			srcdocInjected.replace(
				"</head>",
				`${buildRuntimeCollectorScript(context)}</head>`,
			)
		:	`${buildRuntimeCollectorScript(context)}${srcdocInjected}`;

	return injected.replace(
		/(src|href|poster)=("|')([^"']+)(\2)/gi,
		(full, attribute, quote, value) => {
			const rewritten = rewriteDocumentAssetUrl(value, context);
			if (!rewritten) {
				return full;
			}
			return `${attribute}=${quote}${rewritten}${quote}`;
		},
	);
}

async function serveStaticFile(res, filePath) {
	try {
		const content = await fsp.readFile(filePath);
		res.writeHead(200, {
			"Content-Type": getMimeType(filePath),
			"Content-Length": content.length,
			"Cache-Control": "no-store",
		});
		res.end(content);
	} catch (error) {
		sendJson(res, 404, {
			error: "File not found",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

async function handleApi(req, res, url) {
	if (req.method === "GET" && url.pathname === "/api/config") {
		return sendJson(res, 200, {
			defaultSourceDir: runtimeConfig.defaultSourceDir,
			isDesktop: Boolean(process.versions.electron),
		});
	}

	if (req.method === "POST" && url.pathname === "/api/pick-playable") {
		try {
			const body = await parseRequestBody(req);
			const picked = await (
				runtimeConfig.pickPlayableFile || pickPlayableFile
			)(body.sourceDir);
			if (!picked) {
				return sendJson(res, 200, { cancelled: true });
			}
			return sendJson(res, 200, picked);
		} catch (error) {
			return sendJson(res, 400, {
				error: "Failed to pick playable",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (req.method === "POST" && url.pathname === "/api/scan") {
		try {
			const body = await parseRequestBody(req);
			const sourceDir = ensurePlayableSourceDir(body.sourceDir);
			const fileNames =
				Array.isArray(body.fileNames) ? body.fileNames : [];
			const results = [];
			for (const fileName of fileNames) {
				results.push(await scanPlayable(sourceDir, fileName));
			}
			return sendJson(res, 200, { sourceDir, results });
		} catch (error) {
			return sendJson(res, 400, {
				error: "Scan failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return false;
}

async function handlePreview(req, res, url) {
	const sourceDir = ensurePlayableSourceDir(
		url.searchParams.get("sourceDir"),
	);
	const fileName = url.searchParams.get("file");
	const collectRuntimeResources =
		url.searchParams.get("collectRuntime") === "1";
	if (!fileName) {
		return sendJson(res, 400, { error: "Missing file parameter" });
	}
	const targetFile = path.join(sourceDir, fileName);
	if (!ensureInside(sourceDir, targetFile)) {
		return sendJson(res, 403, { error: "Blocked file path" });
	}
	try {
		const html = await fsp.readFile(targetFile, "utf8");
		return sendText(
			res,
			200,
			rewriteHtmlDocument(html, {
				entryFileName: fileName,
				collectRuntimeResources,
				sourceDir,
				localFilePath: targetFile,
				remoteUrl: null,
			}),
			"text/html; charset=utf-8",
		);
	} catch (error) {
		return sendJson(res, 404, {
			error: "Preview load failed",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

async function handleLocalAsset(res, url) {
	const filePath = url.searchParams.get("file");
	const sourceDir = ensurePlayableSourceDir(
		url.searchParams.get("sourceDir") || runtimeConfig.defaultSourceDir,
	);
	if (!filePath) {
		return sendJson(res, 400, { error: "Missing file parameter" });
	}
	const resolved = path.resolve(filePath);
	const allowedBase = path.resolve(sourceDir, "..");
	if (!ensureInside(allowedBase, resolved)) {
		return sendJson(res, 403, { error: "Blocked local asset path" });
	}
	if ([".html", ".htm"].includes(path.extname(resolved).toLowerCase())) {
		try {
			const html = await fsp.readFile(resolved, "utf8");
			return sendText(
				res,
				200,
				rewriteHtmlDocument(html, {
					entryFileName:
						url.searchParams.get("entryFileName") || null,
					collectRuntimeResources:
						url.searchParams.get("collectRuntime") === "1",
					sourceDir,
					localFilePath: resolved,
					remoteUrl: null,
				}),
				"text/html; charset=utf-8",
			);
		} catch (error) {
			return sendJson(res, 404, {
				error: "File not found",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return serveStaticFile(res, resolved);
}

function filterProxyHeaders(headers) {
	const blocked = new Set([
		"host",
		"origin",
		"referer",
		"content-length",
		"connection",
	]);
	const output = {};
	for (const [key, value] of Object.entries(headers)) {
		if (!value || blocked.has(key.toLowerCase())) continue;
		output[key] = value;
	}
	return output;
}

async function readRequestBuffer(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

async function handleProxy(req, res, url) {
	const targetUrl = url.searchParams.get("url");
	if (!targetUrl) {
		return sendJson(res, 400, { error: "Missing url parameter" });
	}
	try {
		const method = (req.method || "GET").toUpperCase();
		const body =
			method === "GET" || method === "HEAD" ?
				undefined
			:	await readRequestBuffer(req);
		const response = await fetch(targetUrl, {
			method,
			body,
			headers: {
				...filterProxyHeaders(req.headers),
				"user-agent": "PlayableExtractor/1.0",
			},
		});
		if (!response.ok) {
			return sendJson(res, 502, {
				error: "Upstream fetch failed",
				status: response.status,
				statusText: response.statusText,
			});
		}

		const contentType =
			response.headers.get("content-type") || "application/octet-stream";
		if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
			const html = await response.text();
			return sendText(
				res,
				200,
				rewriteHtmlDocument(html, {
					entryFileName:
						url.searchParams.get("entryFileName") || null,
					collectRuntimeResources:
						url.searchParams.get("collectRuntime") === "1",
					sourceDir: null,
					localFilePath: null,
					remoteUrl: targetUrl,
				}),
				"text/html; charset=utf-8",
			);
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		res.writeHead(200, {
			"Content-Type": contentType,
			"Content-Length": buffer.length,
			"Cache-Control": "no-store",
			"Access-Control-Allow-Origin": "*",
		});
		res.end(buffer);
	} catch (error) {
		return sendJson(res, 502, {
			error: "Proxy request failed",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

function createAppServer() {
	return http.createServer(async (req, res) => {
		const url = new URL(req.url, `http://${req.headers.host}`);

		try {
			const apiHandled = await handleApi(req, res, url);
			if (apiHandled !== false) {
				return;
			}

			if (req.method === "GET" && url.pathname === "/preview") {
				return handlePreview(req, res, url);
			}

			if (req.method === "GET" && url.pathname === "/local-asset") {
				return handleLocalAsset(res, url);
			}

			if (url.pathname === "/proxy") {
				return handleProxy(req, res, url);
			}

			if (
				req.method === "GET" &&
				(url.pathname === "/" || url.pathname.startsWith("/public/"))
			) {
				const target =
					url.pathname === "/" ?
						path.join(
							runtimeConfig.staticRoot,
							"public",
							"index.html",
						)
					:	path.join(runtimeConfig.staticRoot, url.pathname);
				return serveStaticFile(res, target);
			}

			return notFound(res);
		} catch (error) {
			return sendJson(res, 500, {
				error: "Internal server error",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

function resolveConfiguredPort(port) {
	const parsed = Number(port);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PORT;
}

function closeServer(server) {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function startServer(options = {}) {
	runtimeConfig.port = resolveConfiguredPort(
		options.port ?? process.env.PORT,
	);
	runtimeConfig.defaultSourceDir = path.resolve(
		options.defaultSourceDir ||
			process.env.PLAYABLE_SOURCE_DIR ||
			DEFAULT_SOURCE_DIR,
	);
	runtimeConfig.shouldAutoOpenBrowser =
		typeof options.shouldAutoOpenBrowser === "boolean" ?
			options.shouldAutoOpenBrowser
		:	DEFAULT_SHOULD_AUTO_OPEN_BROWSER;
	runtimeConfig.staticRoot = path.resolve(
		options.staticRoot || DEFAULT_STATIC_ROOT,
	);
	runtimeConfig.pickPlayableFile =
		typeof options.pickPlayableFile === "function" ?
			options.pickPlayableFile
		:	null;

	const server = createAppServer();

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(runtimeConfig.port, () => {
			server.off("error", reject);
			const address = server.address();
			const actualPort =
				typeof address === "object" && address ?
					address.port
				:	runtimeConfig.port;
			const localUrl = `http://localhost:${actualPort}`;
			console.log(`Playable extractor running at ${localUrl}`);
			console.log(
				`Default source directory: ${runtimeConfig.defaultSourceDir}`,
			);
			if (runtimeConfig.shouldAutoOpenBrowser) {
				openBrowser(localUrl).catch((error) => {
					console.warn(
						`Failed to open browser automatically: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
			}
			resolve({
				server,
				port: actualPort,
				url: localUrl,
				close: () => closeServer(server),
			});
		});
	});
}

module.exports = {
	startServer,
	createAppServer,
	closeServer,
};

if (require.main === module) {
	startServer().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
