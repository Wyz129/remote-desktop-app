'use strict';
const api = window.serverBrowser;
const $ = id => document.getElementById(id);
let loading = false;
function message(value, error = false) { $('status').textContent = value; $('status').classList.toggle('error', error); }
async function invoke(action, payload) { try { return await api.call(action, payload); } catch (error) { message(error.message, true); return null; } }
$('navigation').addEventListener('submit', event => { event.preventDefault(); void invoke('navigate', { url: $('address').value }); });
$('back').addEventListener('click', () => void invoke('back'));
$('forward').addEventListener('click', () => void invoke('forward'));
$('reload').addEventListener('click', () => void invoke(loading ? 'stop' : 'reload'));
async function setDestination() { $('serverDirectory').hidden = $('destination').value !== 'server'; await invoke('destination', { destination: $('destination').value, serverDirectory: $('serverDirectory').value }); }
$('destination').addEventListener('change', () => void setDestination());
$('serverDirectory').addEventListener('change', () => void setDestination());
$('clearSession').addEventListener('click', async () => { await invoke('clearSession'); message('本次连接的浏览器登录态和缓存已清除。'); });
$('help').addEventListener('click', () => message('支持 Cookie 登录态、POST 响应和网页 blob 下载；下载进度见桌面传输中心。服务器保存先暂存本机再上传。禁用本机文件、设备权限及非 HTTP(S) 导航；不模拟 DRM、网站后台或 File System Access 下载。'));
api.onEvent(value => { if (value.type !== 'state') return; if (document.activeElement !== $('address') && value.url) $('address').value = value.url; $('back').disabled = !value.canBack; $('forward').disabled = !value.canForward; loading = value.loading; $('reload').textContent = loading ? '×' : '↻'; $('reload').title = loading ? '停止加载' : '重新载入'; message(value.error || (loading ? '正在通过 SSH 加载…' : `${value.title || '服务器网络浏览器'} · 网页已隔离`), Boolean(value.error)); });
void invoke('load').then(value => { if (value) { $('destination').value = value.destination; $('serverDirectory').value = value.serverDirectory; $('serverDirectory').hidden = value.destination !== 'server'; } });
