'use strict';
const api = window.serverBrowser;
const $ = id => document.getElementById(id);
let loading = false;
let detailsExpanded = false;
let toolbarHeight = 0;
let layoutFrame = 0;
function updateLayout() {
  if (layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    const height = Math.ceil($('browserChrome').getBoundingClientRect().height);
    if (height === toolbarHeight) return;
    toolbarHeight = height;
    // Only this isolated, trusted toolbar can request its native view height.
    void api.call('toolbarLayout', { height }).catch(() => {});
  });
}
function message(value, error = false) {
  $('status').textContent = value; $('status').classList.toggle('error', error);
  $('status').hidden = !detailsExpanded && !error;
  updateLayout();
}
function setDetails(expanded) {
  detailsExpanded = expanded;
  $('browserDetails').hidden = !expanded;
  $('toggleDetails').setAttribute('aria-expanded', String(expanded));
  $('status').hidden = !expanded && !$('status').classList.contains('error');
  updateLayout();
}
new ResizeObserver(updateLayout).observe($('browserChrome'));
$('toggleDetails').addEventListener('click', () => setDetails(!detailsExpanded));
async function invoke(action, payload) { try { return await api.call(action, payload); } catch (error) { message(error.message, true); return null; } }
function renderTabs(tabs) {
  $('tabs').replaceChildren();
  for (const tab of tabs || []) {
    const item = document.createElement('div'); item.className = `browser-tab${tab.active ? ' active' : ''}`; item.dataset.tabId = tab.id;
    const select = document.createElement('button'); select.type = 'button'; select.className = 'tab-select'; select.textContent = tab.title || '新标签页'; select.title = tab.url || tab.title; select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(tab.active)); select.addEventListener('click', () => void invoke('selectTab', { id: tab.id }));
    const close = document.createElement('button'); close.type = 'button'; close.className = 'tab-close'; close.title = '关闭标签页'; close.setAttribute('aria-label', `关闭 ${tab.title || '标签页'}`); close.addEventListener('click', () => void invoke('closeTab', { id: tab.id }));
    const closeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); closeIcon.setAttribute('viewBox', '0 0 20 20'); closeIcon.setAttribute('aria-hidden', 'true');
    const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path'); closePath.setAttribute('d', 'M5 5l10 10M15 5L5 15'); closeIcon.append(closePath); close.append(closeIcon);
    item.append(select, close); $('tabs').append(item);
    if (tab.active) item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
$('newTab').addEventListener('click', () => void invoke('newTab'));
$('navigation').addEventListener('submit', event => { event.preventDefault(); void invoke('navigate', { url: $('address').value }); });
$('back').addEventListener('click', () => void invoke('back'));
$('forward').addEventListener('click', () => void invoke('forward'));
$('reload').addEventListener('click', () => void invoke(loading ? 'stop' : 'reload'));
async function setDestination() { $('serverDirectory').hidden = $('destination').value !== 'server'; await invoke('destination', { destination: $('destination').value, serverDirectory: $('serverDirectory').value }); }
$('destination').addEventListener('change', () => void setDestination());
$('serverDirectory').addEventListener('change', () => void setDestination());
$('clearSession').addEventListener('click', async () => { await invoke('clearSession'); message('本次连接的浏览器登录态和缓存已清除。'); });
$('help').addEventListener('click', () => message('支持 Cookie 登录态、POST 响应和网页 blob 下载；下载进度见桌面传输中心。服务器保存先暂存本机再上传。禁用本机文件、设备权限及非 HTTP(S) 导航；不模拟 DRM、网站后台或 File System Access 下载。'));
api.onEvent(value => { if (value.type !== 'state') return; renderTabs(value.tabs); if (document.activeElement !== $('address') && value.url) $('address').value = value.url; $('back').disabled = !value.canBack; $('forward').disabled = !value.canForward; loading = value.loading; $('reload').textContent = loading ? '×' : '↻'; $('reload').title = loading ? '停止加载' : '重新载入'; $('reload').setAttribute('aria-label', $('reload').title); message(value.error || (loading ? '正在通过 SSH 加载…' : `${value.title || '浏览器'} · 网页已隔离`), Boolean(value.error)); });
void invoke('load').then(value => { if (value) { $('destination').value = value.destination; $('serverDirectory').value = value.serverDirectory; $('serverDirectory').hidden = value.destination !== 'server'; } });
