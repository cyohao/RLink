# CLAUDE.md — 瑞联 R-Link 项目说明

接手开发前先读完这份文件，再看 README.md（功能和使用说明）和 docs/ 下的两份设计文档。

## 项目是什么

接口联调工具「瑞联 R-Link」，有三块功能：模拟接口、接口调用（类似 Postman）、请求日志。有两种形态：

- **服务器版**：`src/`，Node.js + Express，用 Docker 部署在服务器上。
- **桌面版**：`desktop/src-tauri/`，Tauri 2 + Rust。内置服务是服务器版的 **Rust 重写**；窗口加载内置服务提供的页面（`http://127.0.0.1:<端口>/__admin/`）。

两种形态**共用同一套页面**（`public/`，原生 JS，没有构建步骤）。桌面版编译时把 `public/` 打包进 exe（`include_dir!`）。

## 用户和协作习惯

- 用户用中文交流。界面文字、注释、文档都用中文，风格是「说人话」：短句，不用生僻术语。
- 较大的功能**先出设计方案（写到 docs/），用户确认后再动手**。小改动直接做。
- 用户的原话是「都是使用 AI 开发，不考虑维护，快速简单实现」：优先选最快能交付的方案，但测试和实际验证不能省。
- 做完要实际验证：跑测试，界面改动要真的打开看，交付物要实际安装一遍，并如实报告结果。
- 用户给的名称和决定不要自作主张修改。改名、改标识这类会影响已安装程序或数据的事，先说明影响再做。

## 已经定下的决定（不要推翻）

| 事项 | 决定 |
|---|---|
| 名称 | 中文名「瑞联」（公司是**华瑞**，不是「华锐」）；窗口标题和页面 `<title>` 是「瑞联 R-Link」；页面顶栏、开始菜单、安装包名用「瑞联」 |
| 英文和技术标识 | 程序文件 `ruilink.exe`，Cargo 包名 `ruilink`，接口调用的 User-Agent 是 `RuiLink/1.0`，Tauri 的 identifier 是 `com.huarui.ruilink`（**决定了桌面版数据目录，不要改**） |
| 没改名的部分 | Docker 镜像和容器名、npm 包名仍是 `mock-api-server`，数据卷是 `mock-data`。改了会影响服务器上已有的部署，用户要求时再改 |
| 接口调用的安全 | 服务器版必须设置 `ADMIN_TOKEN` 才能用接口调用（否则返回 403）；可选 `PROXY_ALLOW_HOSTS` 白名单、`CLIENT_ENABLED=false` 关闭 |
| 历史记录 | 本机历史存在浏览器 localStorage（最多 100 条）；单条可以「保存到服务器」，存为服务器记录（records.json，最多 500 条，所有人可见） |
| 集合 | 只有一层分组 |
| 导出 | 包含模拟接口、集合和请求；**不包含环境变量**（可能有 token），也不包含历史和记录。导出格式 version 2，导入兼容 version 1 |
| 数据存储 | JSON 文件，不用数据库。写文件时先写临时文件再改名 |
| 桌面版 | 只支持 Windows；离线可用；用 NSIS 安装包，安装到当前用户目录（不需要管理员权限）；不做自动更新和代码签名 |
| 网页版的发送方式 | 只有「服务器转发」。「浏览器直接发送」和「本机代理（网页版借用桌面版发请求）」讨论过，用户决定**暂不做** |

## 架构要点

### 服务器版的请求处理顺序（src/app.js）

`/__health` → `/__admin/api/*`（管理接口：先解析 JSON，`/info` 不需要口令，其余都要校验 `X-Admin-Token`）→ `/__admin/` 静态页面 → 允许跨域的中间件 → 模拟接口处理器。

- 模拟接口处理：条件场景 → 参数校验 → 默认返回；然后渲染模板；最后写入请求日志（只保存在内存里，最多 300 条）。
- 没有匹配的接口时返回 404，返回体是 `{code:'404', msg, data:null}`。没有匹配且是 `GET /` 时，重定向到 `/__admin/`。

### 管理接口（两版完全一致）

| 分类 | 接口 |
|---|---|
| 基本 | `GET /info`（返回 `{authRequired, mockCount, client:{enabled,reason}, desktop?}`） |
| 模拟接口 | `GET /mocks`、`GET/POST/PUT/DELETE /mocks/:id`（新增是 `POST /mocks`） |
| 请求日志 | `GET /logs?mockId=&limit=`、`DELETE /logs` |
| 导入导出 | `GET /export`、`POST /import {mode, mocks, client?}` |
| 接口调用 | `GET /client`（返回集合、请求、环境、允许访问的地址、内置函数名）、集合和请求的增删改、`PUT /client/environments`、`POST /client/preview`（只替换变量，不发送）、`POST /client/send`、`/client/records` 的增删改查 |
| 仅桌面版 | `GET/PUT /desktop`、`POST /desktop/test`、`POST /desktop/open-data-dir` |

### 接口调用

- `POST /client/send` 的请求体是 `{request, variables, envName}`。变量由前端直接传入，服务器不保存状态。
- 处理流程：规范化 → 检查有没有未定义的简单变量（`{{name}}`）→ 用 `renderText` 做纯文本替换 → 拼出 URL（`/` 开头的指向本服务自己，没写协议时补 `http://`）→ 检查白名单 → 发送（手动处理重定向，最多 5 次；跨主机时去掉 Authorization 和 Cookie；响应最大 10MB；支持 gzip、br、deflate 解压和各种字符集）→ 返回 `{sent, finalUrl, redirects, timing, response | error}`。
- 发送失败也返回 HTTP 200，错误放在 `error` 里；只有参数本身有问题才返回 4xx。

### 桌面版特有（desktop.rs、lib.rs）

- 启动时生成随机口令，作为本机的 `ADMIN_TOKEN`，通过 Tauri 的 `initialization_script` 写进 `localStorage.mockAdminToken`。
- 默认监听 `127.0.0.1:3000`，被占用时换一个空闲端口。打开「允许局域网访问」后监听 `0.0.0.0`。
- **连接服务器模式**：除 `/info`、`/desktop/*`、`/client/send`、`/client/preview` 外，管理接口原样转发到远端服务器。远端返回 401 时改成 502，并给出明确提示，避免页面弹出「输入本机口令」。相对地址指向远端服务器。前端用 `mockOrigin` 变量（在 public/app.js）把模拟接口的地址指向远端。
- `ruilink.exe --serve --port N --data-dir D --token T [--allow-hosts X] [--client-enabled false]`：不开窗口，只运行服务，对照测试用这个模式。发布版没有命令行窗口，看不到输出，调试时用 `cargo build` 出的调试版。
- 设置了环境变量 `HUARUI_DEVTOOLS_PORT=9360` 时，会打开 WebView2 的远程调试端口，用于自动化测试（见下文「验证方法」）。

### Node 版和 Rust 版的文件对应

| Node（src/） | Rust（desktop/src-tauri/src/） |
|---|---|
| template.js | template.rs |
| engine.js | engine.rs |
| store.js | store.rs |
| clientStore.js | client_store.rs |
| clientRouter.js | client.rs（核心逻辑）+ server.rs（路由） |
| httpClient.js | http_client.rs |
| app.js | server.rs |
| index.js | lib.rs |
| — | js.rs：模拟 JS 的行为，包括数字格式、`Number()`、`String()`、真假值、`parseInt` |
| — | desktop.rs：设置、转发、端口绑定 |

Rust 版要特别对齐的细节（已经处理好，改的时候别弄坏）：
- serde_json 打开了 `preserve_order`，保证 JSON 字段顺序不变；
- 整数输出为 `3` 而不是 `3.0`；
- 查询参数解析和 Express 的 qs 一样：同名参数变成数组，`a[b]` 变成嵌套对象；
- 请求头名称一律小写；
- 文本响应的 Content-Type 一律带上 `charset=utf-8`（和 Express 的 `res.send` 一样）。

## 开发规则

1. **服务器行为要两边一起改**。凡是改了 HTTP 接口、数据格式、模板语法、校验规则，`src/*.js` 和 `desktop/src-tauri/src/*.rs` 都要改，并在 `test/compat.test.js` 里加用例。对照测试只能通过 HTTP 调用，不能引用任何一边的内部代码。
2. 改了 `src/seeds.js`，要重新导出给桌面版：
   `node -e "process.stdout.write(JSON.stringify(require('./src/seeds'), null, 2))" > desktop/src-tauri/seeds.json`
3. 页面代码的约定：用 `h(tag, attrs, ...children)` 生成元素。往 DOM 里塞子元素时用 `h()`；client.js 里有一个过滤空值的 `put(el, ...kids)`。**不要直接把 null 传给 `replaceChildren`**，会显示成「null」文字。改样式时，深色模式的颜色变量要一起定义。
4. 页面上的公共函数都定义在 public/app.js（`api`、`toast`、`h`、`field`、`codeArea`、`copyText` 等），`client.js` 和 `desktop.js` 直接使用，加载顺序是 app.js → client.js → desktop.js。
5. 代码风格跟着周围走：中文注释，只在不好理解的地方写，篇幅适中。

## 测试和验证

```bash
npm test                                          # 55 个测试：服务器版的单元、集成测试，加上对照测试的 Node 版
cd desktop/src-tauri && cargo test --lib          # 21 个 Rust 单元测试
cargo build && cd ../.. && MOCK_IMPL=rust node --test test/compat.test.js   # 20 个对照测试，Rust 版
```

**验证界面**：用无头 Chrome 加 DevTools 协议驱动页面，Node 24 自带 WebSocket，不需要装 puppeteer。要点：
- 服务器版：启动服务，比如 `PORT=3917 ADMIN_TOKEN=tk DATA_DIR=临时目录 node src/index.js`，Chrome 加 `--headless=new --remote-debugging-port=...`。页面会用 `prompt()` 要口令，要监听 `Page.javascriptDialogOpening`，用 `Page.handleJavaScriptDialog` 填入口令。
- 桌面版：先设置 `HUARUI_DEVTOOLS_PORT=9360` 再启动 exe，然后连接 `http://127.0.0.1:9360/json` 里 URL 包含 `/__admin/` 的那个页面。
- 用 `Page.captureScreenshot` 截图，再用 Read 工具查看。浅色、深色（`Emulation.setEmulatedMedia`）和窄屏（420px 宽）都要看。

**验证安装包**：
- 静默安装：`瑞联_x.y.z_x64-setup.exe /S`；
- 检查以下几处：
  - `%LOCALAPPDATA%\瑞联\ruilink.exe`；
  - 开始菜单 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\瑞联.lnk`；
  - 桌面快捷方式；
  - 注册表 `HKCU\...\Uninstall` 里 DisplayName 为「瑞联」的项；
- 静默卸载：`uninstall.exe /S`。

测试完要清理自己产生的测试数据：`%APPDATA%\com.huarui.ruilink`、`%LOCALAPPDATA%\com.huarui.ruilink`。**清理前先确认用户没有在里面存数据**：如果 `mocks.json` 大约是 14123 字节，说明只有预置数据。用户已经装了桌面版，不能直接删。

## 发布桌面版的步骤

1. 改版本号：`desktop/src-tauri/Cargo.toml` 和 `desktop/src-tauri/tauri.conf.json` 两处。当前是 **1.0.1**。
2. 跑完上面三组测试。
3. `cd desktop && npx --yes @tauri-apps/cli@2 build`，生成：
   - 安装包 `src-tauri/target/release/bundle/nsis/瑞联_<版本>_x64-setup.exe`；
   - 免安装版 `src-tauri/target/release/ruilink.exe`。
4. 复制到 `desktop/dist/`，文件命名：
   - `瑞联-v<版本>-安装包.exe`；
   - `瑞联-v<版本>-免安装版.exe`；
   - `瑞联-v<版本>.zip`（内含安装包和使用说明.txt）。
   
   更新 `使用说明.txt`（UTF-8 带 BOM，CRLF 换行），删掉旧版本的文件。
5. 实际静默安装一遍并启动验证，然后卸载、清理测试数据（注意上面说的数据目录）。

注意：安装包的产品名（`productName`）决定安装目录和卸载项。改名后新旧版本会**被当成两个程序并存**，要提醒用户卸载旧版。

## 本机环境的坑（Windows）

- 用 Bash（Git Bash）和 PowerShell 都可以。**用 heredoc 把含反斜杠的 JS 或替换文本传给 `node -` 时，反斜杠会被吃掉**，导致语法错误。这种情况用 Edit 工具，或者先用 Write 工具写成脚本文件再执行，在 JS 里用 `String.fromCharCode(92)` 生成反斜杠。
- PowerShell 的 `Remove-Item` 用变量拼路径会被安全检查拦截，要写完整的字面路径。
- **crates.io 很慢或者超时**：项目里的 `desktop/src-tauri/.cargo/config.toml` 改用了 rsproxy.cn 镜像，只对这个项目生效。
- **GitHub 时通时不通**：打安装包需要的 NSIS 3.13 和 nsis_tauri_utils 已经缓存在 `%LOCALAPPDATA%\tauri\NSIS`，不需要联网。缓存丢失又上不了 GitHub 时，用 `--no-bundle` 只出免安装版。
- 本机的 3999 端口被别的程序占用了，测试时换别的端口，比如 3917。
- 本机工具：Rust 1.99（MSVC）、VS 2022、WebView2、Chrome（`C:/Program Files/Google/Chrome/Application/chrome.exe`）、Docker（守护进程经常没启动）、7-Zip。
- 项目目录**不是 git 仓库**，改动没有版本记录，大改之前要谨慎。

## 已知限制

- 桌面版里点「取消」，页面会立刻显示已取消，但本机发往目标的请求不一定马上中止，最晚到超时时间结束。
- 桌面版的「允许局域网访问」还没有用第二台电脑实测过。
- 改了端口或局域网设置后，需要手动关闭再打开桌面版，没有做自动重启（和「只能运行一个实例」的插件容易冲突）。
- 连接服务器模式下，远端服务器的口令明文保存在 `settings.json` 里。
- 服务器版的 GBK 解码依赖 Node 的完整 ICU，还没有在 `node:22-alpine` 镜像里验证过。

## 还没做的功能（用户讨论过，以后可能要）

- 网页版的「浏览器直接发送」（约半天）和「本机代理」（网页版借用桌面版发请求，约 1 天）。设计思路见对话记录：发送按钮旁加「服务器转发 / 本机代理 / 浏览器直接发送」选择。
- 接口调用第二期：粘贴 curl 导入、导入 Postman 集合、multipart 文件上传、把响应字段提取到变量、断言、**把真实响应一键存为模拟接口**。
- 桌面版：本地工作区和服务器之间自动同步、自动更新、代码签名。
- 把 Docker 和 npm 的名称从 `mock-api-server` 改成新名称。

## 文档

- `README.md`：功能、部署、安装、开发命令（面向使用者）。
- `docs/api-client-design.md`：接口调用的设计，第 12 节是和实现的差异。
- `docs/desktop-design.md`：桌面版的设计，第 12 节是和实现的差异。
