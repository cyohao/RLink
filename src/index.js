'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { Store } = require('./store');
const { ClientStore } = require('./clientStore');
const { parseAllowHosts } = require('./clientRouter');
const seeds = require('./seeds');

// 本地运行时读取项目根目录的 .env；已经设置的系统环境变量优先，不会被覆盖
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE) && typeof process.loadEnvFile === 'function') process.loadEnvFile(ENV_FILE);

// MOCK_PORT 是 docker-compose 用的宿主机端口，本地运行时也认它
const PORT = Number(process.env.PORT) || Number(process.env.MOCK_PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CLIENT_ENABLED = (process.env.CLIENT_ENABLED || 'true').toLowerCase() !== 'false';
const PROXY_ALLOW_HOSTS = process.env.PROXY_ALLOW_HOSTS || '';

try {
  parseAllowHosts(PROXY_ALLOW_HOSTS);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const store = new Store(path.join(DATA_DIR, 'mocks.json'), seeds);
const clientStore = new ClientStore(path.join(DATA_DIR, 'client.json'), path.join(DATA_DIR, 'records.json'));
const app = createApp({ store, clientStore, adminToken: ADMIN_TOKEN, clientEnabled: CLIENT_ENABLED, proxyAllowHosts: PROXY_ALLOW_HOSTS });

app.listen(PORT, () => {
  console.log(`瑞联已启动：http://0.0.0.0:${PORT}`);
  console.log(`管理页面：http://<服务器IP>:${PORT}/__admin/`);
  console.log(`配置文件：${path.join(DATA_DIR, 'mocks.json')}（共 ${store.list().length} 个接口）`);
  if (!ADMIN_TOKEN) {
    console.log('提示：未设置 ADMIN_TOKEN，任何人都能修改接口配置');
    if (CLIENT_ENABLED) console.log('提示：接口调用功能需要设置 ADMIN_TOKEN 后才能使用');
  } else if (!CLIENT_ENABLED) {
    console.log('提示：接口调用功能已关闭（CLIENT_ENABLED=false）');
  } else {
    console.log(`接口调用：允许访问 ${PROXY_ALLOW_HOSTS || '任意地址（可以用 PROXY_ALLOW_HOSTS 限制）'}`);
  }
});
