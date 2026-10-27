'use strict';

// ---------- 桌面端 ----------
// 只在 /info 返回 desktop 字段时生效（桌面应用内置的服务才会返回），网页版什么都不做。
// 复用 app.js 里的 h、field、api、toast、copyText、$、switchView、renderEditor。

const desk = { info: null, detail: null };

async function desktopInit() {
  let info;
  try {
    info = await api('GET', '/info');
  } catch {
    return;
  }
  if (!info.desktop) return;
  desk.info = info.desktop;
  const remote = desk.info.workspace === 'remote';

  // 连接服务器时，模拟接口由服务器提供
  if (remote) {
    mockOrigin = desk.info.remoteUrl;
    if (state.draft) renderEditor();
  }

  const host = remote ? desk.info.remoteUrl.replace(/^https?:\/\//, '') : '';
  $('.brand').after(
    h(
      'button',
      {
        class: `ws-badge ${remote ? 'remote' : 'local'}`,
        title: remote ? '当前读写服务器上的数据，接口调用从本机发出。点击切换' : '当前使用本机数据，可以离线使用。点击切换',
        onclick: () => switchView('desktop'),
      },
      remote ? `服务器：${host}` : '本地工作区',
    ),
  );
  $('.tabs').append(h('button', { class: 'tab', 'data-view': 'desktop', onclick: () => switchView('desktop') }, '桌面设置'));
  $('main').append(h('section', { class: 'view help desktop-view', id: 'view-desktop', hidden: true }));

  if (desk.info.portFallback) toast(`设置的端口已被占用，本次自动改用 ${desk.info.port} 端口`, 'error');
}

async function desktopShow() {
  const box = $('#view-desktop');
  if (!box) return;
  try {
    desk.detail = await api('GET', '/desktop');
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  renderDesktop();
}

function renderDesktop() {
  const d = desk.detail;
  const form = { ...d.settings };
  const box = $('#view-desktop');
  const testResult = h('span', { class: 'muted' });

  const remoteFields = h(
    'div',
    { class: 'grid grid-2', style: 'margin-top:12px' },
    field('服务器地址', h('input', { type: 'text', value: form.remoteUrl, placeholder: 'http://192.168.1.100:3000', oninput: (e) => (form.remoteUrl = e.target.value) })),
    field('服务器的管理口令', h('input', { type: 'text', value: form.remoteToken, placeholder: '服务器上设置的 ADMIN_TOKEN', oninput: (e) => (form.remoteToken = e.target.value) }), '口令保存在本机的设置文件里'),
  );
  const syncRemote = () => (remoteFields.hidden = form.workspace !== 'remote');
  const radio = (value, label, hint) =>
    h(
      'label',
      { class: 'ws-option' },
      h('input', {
        type: 'radio',
        name: 'ws',
        checked: form.workspace === value,
        onchange: () => {
          form.workspace = value;
          syncRemote();
        },
      }),
      h('span', {}, h('b', {}, label), h('span', { class: 'muted' }, hint)),
    );

  const save = async (successText) => {
    try {
      const before = desk.info.workspace;
      desk.detail = await api('PUT', '/desktop', form);
      const now = desk.detail.settings.workspace === 'remote' ? 'remote' : 'local';
      if (now !== before) {
        toast('已切换，正在重新加载…');
        setTimeout(() => location.reload(), 600);
        return;
      }
      toast(successText);
      renderDesktop();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const test = async () => {
    testResult.className = 'muted';
    testResult.textContent = '连接中…';
    try {
      const r = await api('POST', '/desktop/test', { remoteUrl: form.remoteUrl, remoteToken: form.remoteToken });
      testResult.className = r.ok ? 'status-ok' : 'status-bad';
      testResult.textContent = r.message;
    } catch (err) {
      testResult.className = 'status-bad';
      testResult.textContent = err.message;
    }
  };

  const portInput = h('input', { type: 'number', min: 1, max: 65535, value: form.port, style: 'width:140px', oninput: (e) => (form.port = e.target.value) });

  box.replaceChildren(
    h('h2', {}, '工作区'),
    h(
      'div',
      { class: 'card' },
      radio('local', '本地工作区', '数据保存在本机，模拟接口由本机提供，断网也能用'),
      radio('remote', '连接服务器', '模拟接口、集合、环境、日志都读写服务器上的数据，和团队共享；接口调用仍从本机发出，能访问本机和所在局域网'),
      remoteFields,
      h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn primary', onclick: () => save('已保存') }, '保存'), h('button', { class: 'btn ghost', onclick: test }, '测试连接'), testResult),
      h('p', { class: 'hint' }, '两种工作区的数据互不影响，不会自动同步。需要同步时，在一边「导出配置」，切换后在另一边「导入配置」（环境变量不会导出，需要重新配置）。'),
    ),

    h('h2', {}, '本机服务'),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'row', style: 'align-items:flex-end;gap:24px;flex-wrap:wrap' },
        field('端口', portInput, `本次使用 ${d.port}${d.portFallback ? `（设置的 ${d.requestedPort} 被占用，自动更换）` : ''}`),
        h('label', { class: 'check', style: 'padding-bottom:22px' }, h('input', { type: 'checkbox', checked: form.lan, onchange: (e) => (form.lan = e.target.checked) }), '允许局域网访问'),
      ),
      h('p', { class: 'hint' }, '打开后，局域网里的其他电脑也能调用本机的模拟接口。修改端口或这个选项后，需要关闭应用再重新打开才生效。'),
      d.lanActive
        ? h(
            'div',
            { class: 'notice', style: 'margin:10px 0' },
            h('div', {}, '局域网访问地址：', h('code', {}, d.lanUrl || '（没有找到本机的局域网 IP）')),
            h('div', { style: 'margin-top:6px' }, '管理页面口令：', h('code', {}, d.localToken), ' ', h('button', { class: 'btn small ghost', onclick: () => copyText(d.localToken) }, '复制'), h('span', { class: 'muted' }, '　只有打开管理页面时需要；调用模拟接口不需要口令。每次启动应用都会变')),
          )
        : null,
      d.restartRequired ? h('div', { class: 'notice', style: 'margin:10px 0' }, '端口或局域网设置已修改，关闭应用再重新打开后生效') : null,
      h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn primary', onclick: () => save('已保存，重新打开应用后生效') }, '保存')),
    ),

    h('h2', {}, '数据目录'),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'row' }, h('code', { style: 'word-break:break-all' }, d.dataDir), h('button', { class: 'btn small ghost', onclick: () => api('POST', '/desktop/open-data-dir').catch((err) => toast(err.message, 'error')) }, '打开所在文件夹')),
      h('p', { class: 'hint' }, 'mocks.json：模拟接口；client.json：集合、请求、环境变量；records.json：保存到「服务器记录」的调用；settings.json：桌面设置。文件格式和服务器版一样，可以直接拷贝。'),
    ),
  );
  syncRemote();
}

desktopInit();
