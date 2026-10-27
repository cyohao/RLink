# 瑞联 R-Link

接口联调工具，由三块功能组成：

- **模拟接口**：在网页上配置接口的路由、参数校验和返回值，保存后立即生效，供对接方联调使用；
- **接口调用**：类似 Postman，调用对方的真实接口或本服务的模拟接口；
- **请求日志**：记录对方实际传了什么、返回了什么。

有两种形态，功能和数据格式完全一致：

| 形态 | 适用场景 | 技术 |
|---|---|---|
| **服务器版** | 部署在服务器上，团队共用，对接方直接调用模拟接口 | Node.js + Express，Docker 部署 |
| **桌面版（Windows）** | 个人电脑上使用，可以离线；能调用本机和所在局域网的接口；也可以连接服务器共享数据 | Tauri 2 + Rust，安装包或单个 exe |

两种形态共用同一套页面（`public/`），桌面版的内置服务是服务器版的 Rust 重写。

---

## 一、功能

### 1. 模拟接口（「接口」页）

| 功能 | 说明 |
|---|---|
| 自定义路由 | 方法支持 GET / POST / PUT / PATCH / DELETE / ANY。路径参数写 `/box/:code`，通配符写 `/files/*`（只能放在最后）。多个接口都能匹配同一个请求时，路径写得越具体越优先 |
| 参数校验 | 位置可选 Body / Query / 路径参数 / Header，可设置必填、类型（字符串、数字、整数、布尔、数组、对象）、最大长度、可选值。不通过时返回「校验失败时返回」的内容，`{{error}}` 是错误说明 |
| 条件场景 | 例如「数量 > 200 返回库存不足」。运算符：等于、不等于、大于、大于等于、小于、小于等于、包含、有值、为空；多个条件可选「全部满足」或「任一满足」。没有条件的场景启用后，所有请求都会命中，相当于「强制返回某个错误」 |
| 动态返回值 | 返回值是 JSON 时，`{{...}}` 会被替换：`{{body.taskNo}}`、`{{query.page}}`、`{{params.code}}`、`{{headers.x-token}}`；内置函数如 `{{now 'YYYYMMDD'}}`、`{{seq 'box'}}`、`{{uuid}}`、`{{randomStr 6 'digit'}}`；`$repeat` 按数量生成列表。完整语法见页面上的「使用说明」 |
| 响应头、状态码、延迟 | 都可以配置，响应头的值也支持模板 |
| 调试 | 编辑页底部可以直接发请求测试，或点「在接口调用中打开」 |
| 处理顺序 | 条件场景 → 参数校验 → 默认返回 |

首次启动时预置 5 个接口：昆船 WMS 的 I-01 ~ I-04（按《杀虫库WES系统与昆船烟丝库仓储系统接口对接方案》编写），以及 TUSK 创建任务（按《WES与潜伏式AGV调度系统接口对接文档》编写）。路径是占位的，拿到正式地址后在页面上修改即可。

模拟接口允许浏览器跨域调用。

### 2. 请求日志（「请求日志」页）

记录最近 300 次调用模拟接口的完整请求（请求头、Query、请求体）和响应，以及命中了哪个场景或校验结果。可以按接口筛选，每 3 秒自动刷新。日志只保存在内存里，服务重启后清空。

### 3. 接口调用（「接口调用」页）

| 功能 | 说明 |
|---|---|
| 编辑请求 | 方法（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS）、地址、Params（和地址栏双向同步）、Headers、Body（无 / JSON / 表单 / 纯文本）、设置（超时、是否跟随重定向、忽略 HTTPS 证书错误） |
| 地址写法 | 以 `/` 开头的地址调用本服务自己的模拟接口；没写 `http://` 时自动补上 |
| 查看响应 | 状态码、耗时、大小、响应体（JSON 自动美化）、响应头，以及变量替换后的「实际请求」。支持 gzip / br 解压和 GBK 等字符集 |
| 环境变量 | 左上角「管理」里配置，例如 `baseUrl`、`token`，在地址、Params、Headers、Body 里用 `{{baseUrl}}` 引用；也可以用内置函数。按文本替换；用到未定义的变量时不会发送 |
| 集合 | 把常用请求保存到集合里（一层分组），团队共享 |
| 历史 | 每次发送都记在当前浏览器里（最多 100 条）。点 ☁ 可以把某次调用「保存到服务器」，所有人在「服务器记录」里都能看到（最多 500 条，可写备注），适合留作联调凭证 |
| 其他 | 复制 curl、取消请求、快捷键 `Ctrl+Enter` 发送、`Ctrl+S` 保存 |

**请求从哪里发出：**
- 服务器版：由服务器转发，没有跨域限制，能访问服务器所在内网，但访问不了你自己电脑上的服务。
- 桌面版：由本机发出，能访问本机和所在局域网。

**安全：** 服务器版必须设置 `ADMIN_TOKEN` 才能使用接口调用，还可以用 `PROXY_ALLOW_HOSTS` 限制可访问的地址。

### 4. 导入导出

顶部「导出配置 / 导入配置」：
- 导出内容包括全部模拟接口，以及接口调用的集合和请求，用于备份、迁移，或者在服务器和桌面版之间同步。
- **不导出环境变量**（里面可能有 token），也不导出历史和服务器记录。
- 导入时可以选「合并」（同名接口覆盖，其余保留）或「覆盖」（先清空）。文件里没有集合数据时，不会改动现有的集合；环境变量在任何情况下都不受影响。

---

## 二、服务器版：部署

访问地址：

- 管理页面：`http://服务器IP:3000/__admin/`
- 模拟接口：`http://服务器IP:3000/你配置的路径`
- 健康检查：`http://服务器IP:3000/__health`

### 方式一：Docker（推荐）

```bash
# 1. 把整个项目目录上传到服务器，比如 /opt/mock-server
cd /opt/mock-server

# 2. 设置端口和管理口令
cp .env.example .env
vi .env

# 3. 构建镜像并启动
docker compose up -d --build

# 查看日志 / 停止
docker compose logs -f
docker compose down
```

- 数据保存在 Docker 数据卷 `mock-data` 里，重建容器或升级镜像都不会丢失。
- **改了 `.env` 之后要执行 `docker compose up -d` 才会生效**，`docker compose restart` 不会重新读取环境变量。

服务器不能访问外网时，在能联网的电脑上构建好镜像再复制过去：

```bash
# 在本机（服务器是 x86 Linux 时加 --platform linux/amd64）
docker build -t mock-api-server:1.0.0 .
docker save mock-api-server:1.0.0 -o mock-api-server.tar

# 把 mock-api-server.tar、docker-compose.yml、.env 上传到服务器后
docker load -i mock-api-server.tar
docker compose up -d
```

### 方式二：直接用 Node.js

需要 Node.js 18 或以上；自动读取 `.env` 需要 20.12 或以上。

```bash
npm ci --omit=dev
npm start                       # 会自动读取项目根目录的 .env

# 常驻后台可以用 pm2
npm i -g pm2
pm2 start src/index.js --name mock-api && pm2 save && pm2 startup
```

用 pm2 时，如果启动命令里带了环境变量（`ADMIN_TOKEN=xx pm2 start ...`），pm2 会记住它们，而且优先级比 `.env` 高。要改的话，用 `pm2 restart mock-api --update-env` 带上新值重启。

### 环境变量

`.env` 文件从 `.env.example` 复制。系统里已经设置的同名环境变量优先。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口；本地运行时也认 `MOCK_PORT` |
| `MOCK_PORT` | 3000 | docker compose 映射到宿主机的端口 |
| `ADMIN_TOKEN` | 空 | 管理页面口令。设置后打开管理页面需要输入；模拟接口本身不受影响。**不设置时接口调用不可用** |
| `DATA_DIR` | `./data` | 数据目录 |
| `CLIENT_ENABLED` | `true` | 设为 `false` 关闭接口调用 |
| `PROXY_ALLOW_HOSTS` | 空（不限制） | 接口调用允许访问的地址，逗号分隔，支持 `host`、`host:port`、`*.example.com`、`192.168.1.*`。调用本服务自己的模拟接口不受限制 |

### 数据文件（`DATA_DIR` 下）

| 文件 | 内容 |
|---|---|
| `mocks.json` | 模拟接口配置 |
| `client.json` | 接口调用的集合、请求、环境变量 |
| `records.json` | 保存到服务器的调用记录 |

请求日志和 `seq` 计数只在内存里；接口调用的本机历史在各自浏览器里。

### 注意事项

- 服务器防火墙要放行端口，比如 `firewall-cmd --add-port=3000/tcp --permanent && firewall-cmd --reload`。
- 部署在内网也建议设置 `ADMIN_TOKEN`，否则任何人都能修改接口配置。
- 接口调用的请求从服务器发出，能访问服务器所在的内网，只需要调某几个系统时，建议用 `PROXY_ALLOW_HOSTS` 限制。

---

## 三、桌面版：安装和使用

### 安装

运行 `desktop/dist/瑞联-v<版本>-安装包.exe`：
- 不需要管理员权限，安装到 `%LOCALAPPDATA%\瑞联\`；
- 开始菜单搜「瑞联」可以找到，桌面上也会生成快捷方式；
- 升级时直接运行新版安装包覆盖安装；在「设置 → 应用」里卸载，**卸载不会删除数据**；
- 也有免安装版 `瑞联-v<版本>-免安装版.exe`，双击直接运行，和安装版共用数据；
- 第一次运行时如果 Windows 提示「已保护你的电脑」，点「更多信息 → 仍要运行」（没有代码签名）；
- 要求 Windows 10 或 11（自带 WebView2）。

### 两种工作区（在「桌面设置」页切换）

| | 本地工作区（默认） | 连接服务器 |
|---|---|---|
| 模拟接口、集合、环境、服务器记录 | 存在本机 | 读写服务器 |
| 请求日志 | 本机内置服务收到的调用 | 服务器的日志 |
| 模拟接口由谁提供 | 本机 `http://127.0.0.1:3000/...` | 服务器 |
| 接口调用从哪里发出 | 本机 | **本机**（相对地址指向服务器） |
| 断网时 | 可用 | 不可用 |

- 两个工作区的数据互不影响，用「导出配置 / 导入配置」手动同步。
- 连接服务器时要填服务器地址和服务器的 `ADMIN_TOKEN`，可以先点「测试连接」。

### 其他设置

- **端口**：默认 3000，被占用时自动换一个空闲端口并提示。
- **允许局域网访问**：打开后，局域网里的其他电脑能调本机的模拟接口；页面上会显示访问地址和本机管理口令。

改了端口或局域网设置，要关闭应用再打开才生效。

- 同一时间只能运行一个，重复打开会切换到已有窗口。
- 本机管理口令每次启动时随机生成，自动带给页面，用户不需要输入。

### 数据位置

`%APPDATA%\com.huarui.ruilink\`，文件和服务器版一样（`mocks.json`、`client.json`、`records.json`），另外多一个 `settings.json`（桌面设置）。在「桌面设置」里点「打开所在文件夹」可以直接打开。

---

## 四、开发

### 目录结构

```
src/                    服务器版（Node.js）
  index.js              启动入口：读取 .env 和环境变量
  app.js                HTTP 服务：管理接口、请求日志、模拟接口处理、导入导出
  engine.js             路由匹配、参数校验、条件场景
  template.js           模板引擎（只支持取值和内置函数，不执行任意代码）
  store.js              模拟接口配置的读写
  clientStore.js        接口调用：集合、请求、环境、服务器记录的读写
  clientRouter.js       接口调用：管理接口、变量替换、访问白名单
  httpClient.js         接口调用：发出 HTTP 请求（超时、重定向、解压、字符集）
  seeds.js              首次启动时预置的接口
public/                 页面（原生 JS，不依赖外网），服务器版和桌面版共用
  app.js                接口、请求日志、导入导出、公共工具函数
  client.js             接口调用
  desktop.js            桌面设置（只在桌面版生效）
test/
  app.test.js、template.test.js、client.test.js   服务器版单元和集成测试
  compat.test.js        对照测试：只通过 HTTP 调用，同一套用例测 Node 版和 Rust 版
desktop/                桌面版
  src-tauri/src/        Rust 源码，模块和 src/ 一一对应（另有 js.rs、server.rs、desktop.rs、lib.rs）
  src-tauri/seeds.json  预置接口，由 src/seeds.js 导出
  dist/                 打好的安装包和免安装版
docs/                   设计文档：api-client-design.md（接口调用）、desktop-design.md（桌面版）
CLAUDE.md               给 AI 助手的项目说明，接着开发前先看
```

### 常用命令

```bash
npm install
npm start                                   # 启动服务器版
npm test                                    # 服务器版全部测试（含对照测试的 Node 版）

cd desktop/src-tauri
cargo test --lib                            # Rust 单元测试
cargo build                                 # 调试版，对照测试要用
cd ../..
MOCK_IMPL=rust node --test test/compat.test.js   # 对照测试的 Rust 版

cd desktop
npx @tauri-apps/cli@2 build                 # 发布：生成安装包和免安装版
```

构建桌面版需要：
- Rust（MSVC 工具链）和 VS 2022 C++ 生成工具；
- `desktop/src-tauri/.cargo/config.toml` 配置了国内镜像 rsproxy.cn；
- 打安装包用的 NSIS 缓存在 `%LOCALAPPDATA%\tauri\NSIS`，缓存丢失时需要能访问 GitHub，否则加 `--no-bundle` 只生成免安装版。

### 改动时要注意

- **服务器行为要两边一起改**：Node 版（`src/`）和 Rust 版（`desktop/src-tauri/src/`）的 HTTP 接口、数据格式必须一致。改了一边，另一边也要改，并在 `test/compat.test.js` 里补用例，两边都跑通。
- **改了 `public/` 下的页面，桌面版要重新构建**才会生效，页面是编译进 exe 的。
- **预置接口改了**，要重新导出 `desktop/src-tauri/seeds.json`，命令见 CLAUDE.md。
