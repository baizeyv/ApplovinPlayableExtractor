# Playable Media Extractor

本地小工具，用来把试玩广告 HTML 当成入口，扫描并导出其中的 `data:image`、`data:audio`、`data:video` 等内联资源。

## 功能

- 直接通过系统文件选择框选择一个试玩 HTML
- 在页面中直接预览试玩
- 静态扫描 HTML 本体和其引用/请求到的文本脚本内容
- 预览时监听运行期暴露出的 data URI
- 选择本地下载目录后导出当前试玩的资源文件

## 启动

桌面版开发启动：

```powershell
npm install
npm start
```

这会直接打开 Electron 桌面窗口，不再需要手动打开浏览器。

如果你仍然想用原来的浏览器模式调试本地服务：

```powershell
npm run start:web
```

默认监听 `http://localhost:7733`。

打包 Windows 桌面版：

```powershell
npm install
npm run dist:win
```

构建完成后会生成可直接分发的 `dist/PlayableMediaExtractor.exe`。

如果你不想手动敲命令，也可以在 Windows 里直接双击项目根目录下的 `build.bat`，它会自动安装依赖并执行打包，完成后自动打开 `dist` 目录。

## 可选环境变量

- `PLAYABLE_SOURCE_DIR`: 默认试玩目录
- `PORT`: 端口，默认 `7733`

## 使用说明

1. 启动服务后，用 Edge 或 Chrome 打开 `http://localhost:7733`
2. 点击“选择 HTML”并在系统文件选择框里选中一个试玩文件
3. 点击“扫描当前试玩”进行静态扫描
4. 预览区会自动加载该试玩，运行时监听会继续补充资源
5. 点击“选择下载目录”后，再执行“下载当前资源”

在 Electron 桌面版中，“选择 HTML”和“选择下载目录”都会走系统原生对话框。

如果某些试玩依赖的相对外部文件没有随导出的 HTML 一起保存，预览可能不完整，但静态扫描仍会尽可能继续处理 HTML 与可访问脚本。

## 在其他电脑上运行

当前版本推荐在 Windows 电脑上运行，因为“选择 HTML”按钮使用的是 Windows 本机文件选择框。

### 方式 1：直接分发可执行文件

这是给没有 Node 环境的设备用的。

1. 在有 Node 的机器上执行 `npm install` 和 `npm run dist:win`
2. 把 `dist/PlayableMediaExtractor.exe` 复制到目标 Windows 电脑
3. 双击运行 `PlayableMediaExtractor.exe`
4. 程序会直接打开桌面窗口

如果目标电脑弹出防火墙提示，通常允许即可。即使不需要局域网访问，本地桌面版本身仍可使用。

### 方式 2：源码运行

1. 安装 Node.js 18 或更高版本
2. 把整个 `ApplovinPlayableExtractor` 文件夹复制到目标电脑
3. 打开终端进入项目目录
4. 运行 `npm start`
5. 程序会直接打开 Electron 桌面窗口

如果目标电脑已经占用了 `7733` 端口，可以临时指定其他端口：

```powershell
$env:PORT=7750
npm run start:web
```

Electron 开发启动和浏览器模式都支持这个环境变量。打包版默认使用随机可用端口并由桌面窗口自动连接，一般不需要手动指定。

如果你希望让局域网里的其他电脑访问这台机器上的服务，还需要保证：

1. 两台电脑在同一个网络里
2. Windows 防火墙允许 Node.js 或对应端口入站
3. 用运行机器的局域网 IP 加端口访问，例如 `http://192.168.1.20:7733`

如果你之后还想支持非 Windows 电脑，我建议把“选择 HTML”改成浏览器上传模式，或者恢复一个可选的手动路径输入作为跨平台后备方案。
