'use strict';
window.InterfaceSettings = class InterfaceSettings {
  constructor(options) {
    this.options = options; this.saved = {}; this.draft = null;
    const places = document.getElementById('placesSettingsPanel');
    places.innerHTML = '<h3 class="settings-page-title">目录与侧栏</h3><p class="settings-description">按服务器与账号保存。Root 和 Home 固定；Desktop 的位置在“桌面与外观”中设置。Trash 是目录入口，删除文件仍需单独确认。</p><form id="placesPreferencesForm"><div class="settings-card"><label class="preference-field">Log<div class="path-controls"><input id="settingsLogPath" placeholder="默认 ~/.rdesktop/log"><button type="button" data-browse-place="log">浏览…</button></div></label><label class="preference-field">Trash<div class="path-controls"><input id="settingsTrashPath" placeholder="默认 ~/.rdesktop/trash"><button type="button" data-browse-place="trash">浏览…</button></div></label></div><ul id="settingsPlacesList" class="settings-card preference-list"></ul><div class="settings-card"><label class="preference-field">快捷方式名称<input id="newPlaceLabel" maxlength="80" placeholder="例如 公共项目"></label><label class="preference-field">服务器目录<div class="path-controls"><input id="newPlacePath" placeholder="例如 /srv/projects"><button type="button" data-browse-place="custom">浏览…</button></div></label><div class="preference-field"><button type="button" id="addPlace">添加快捷方式</button></div></div><p id="placesPreferencesError" class="interface-error" role="alert"></p><footer class="settings-footer"><button type="submit" class="primary">保存目录与侧栏</button></footer></form>';
    const shell = document.getElementById('shellSettingsPanel');
    shell.innerHTML = '<h3 class="settings-page-title">上栏与通知</h3><form id="shellPreferencesForm"><div class="settings-card"><label class="preference-field">时间显示<select id="settingsClockMode"><option value="compact">简约 · Sep 21 18:27</option><option value="detailed">详细 · 日期、秒与时区</option></select></label></div><p class="settings-description">勾选显示上栏按钮，使用箭头调整顺序。点击时间可查看本次运行的通知与日历；通知从上栏下方弹出。</p><ul id="settingsToolbarList" class="settings-card preference-list"></ul><p id="shellPreferencesError" class="interface-error" role="alert"></p><footer class="settings-footer"><button type="submit" class="primary">保存上栏设置</button></footer></form>';
    document.getElementById('placesPreferencesForm').addEventListener('submit', event => this.savePlaces(event));
    document.getElementById('shellPreferencesForm').addEventListener('submit', event => this.saveShell(event));
    document.getElementById('addPlace').addEventListener('click', () => {
      const label = document.getElementById('newPlaceLabel').value.trim(), path = document.getElementById('newPlacePath').value.trim();
      if (!label || !path.startsWith('/')) { document.getElementById('placesPreferencesError').textContent = '请输入快捷方式名称和服务器绝对路径。'; return; }
      if (this.draft.shortcuts.length >= 40) { document.getElementById('placesPreferencesError').textContent = '最多保存 40 个目录快捷方式。'; return; }
      const id = `custom-${crypto.randomUUID()}`; this.draft.shortcuts.push({ id, label, path }); this.draft.placeOrder.push(id); this.renderPlaces(); document.getElementById('newPlaceLabel').value = document.getElementById('newPlacePath').value = '';
    });
    for (const button of places.querySelectorAll('[data-browse-place]')) button.addEventListener('click', async () => {
      const input = document.getElementById({ log: 'settingsLogPath', trash: 'settingsTrashPath', custom: 'newPlacePath' }[button.dataset.browsePlace]);
      try { const identity = this.saved.workspaceIdentity; const target = await options.choosePath(input.value); if (target && identity === this.saved.workspaceIdentity) input.value = target; } catch (error) { document.getElementById('placesPreferencesError').textContent = error.message; }
    });
  }
  apply(saved) { this.saved = saved; }
  open() {
    this.draftIdentity = this.saved.workspaceIdentity || '';
    const source = this.saved.workspacePreferences || {};
    this.draft = { logPath: source.logPath || '', trashPath: source.trashPath || '', shortcuts: (source.shortcuts || []).map(item => ({ ...item })), placeOrder: [...new Set([...(source.placeOrder || []), 'root', 'home', 'desktop', 'log', 'trash'])] };
    this.shellDraft = { clockMode: this.saved.shellPreferences?.clockMode || 'compact', toolbarOrder: [...new Set([...(this.saved.shellPreferences?.toolbarOrder || []), ...this.toolbar().map(([id]) => id)])], toolbarHidden: [...(this.saved.shellPreferences?.toolbarHidden || ['browserButton'])] };
    document.getElementById('settingsLogPath').value = this.draft.logPath; document.getElementById('settingsTrashPath').value = this.draft.trashPath;
    document.getElementById('settingsClockMode').value = this.shellDraft.clockMode;
    document.getElementById('placesPreferencesError').textContent = document.getElementById('shellPreferencesError').textContent = '';
    this.renderPlaces(); this.renderToolbar();
  }
  toolbar() { return [['connectButton', '切换账号'], ['downloadsButton', '传输中心'], ['activityButton', '实时监听'], ['homeShortcut', 'Home'], ['desktopSettings', '设置'], ['fullscreen', '全屏'], ['exitButton', '退出'], ['browserButton', '浏览器']]; }
  moveButtons(list, order, id, redraw) {
    for (const [label, delta] of [['上移', -1], ['下移', 1]]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = delta < 0 ? '↑' : '↓'; button.title = label; button.setAttribute('aria-label', label); const index = order.indexOf(id); button.disabled = index + delta < 0 || index + delta >= order.length; button.addEventListener('click', () => { [order[index], order[index + delta]] = [order[index + delta], order[index]]; redraw(); }); list.append(button); }
  }
  renderPlaces() {
    const list = document.getElementById('settingsPlacesList'); list.replaceChildren();
    const builtin = { root: ['Root', '/'], home: ['Home', this.options.home()], desktop: ['Desktop', this.options.desktop()], log: ['Log', this.draft.logPath || '~/.rdesktop/log'], trash: ['Trash', this.draft.trashPath || '~/.rdesktop/trash'] };
    for (const id of this.draft.placeOrder) {
      const custom = this.draft.shortcuts.find(item => item.id === id), info = builtin[id] || (custom && [custom.label, custom.path]); if (!info) continue;
      const row = document.createElement('li'), label = document.createElement('span'), detail = document.createElement('small'); label.className = 'preference-label'; label.textContent = info[0]; detail.textContent = info[1]; label.append(detail); row.append(label);
      this.moveButtons(row, this.draft.placeOrder, id, () => this.renderPlaces());
      if (custom) { const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'; remove.addEventListener('click', () => { this.draft.shortcuts = this.draft.shortcuts.filter(item => item.id !== id); this.draft.placeOrder = this.draft.placeOrder.filter(item => item !== id); this.renderPlaces(); }); row.append(remove); }
      list.append(row);
    }
  }
  renderToolbar() {
    const list = document.getElementById('settingsToolbarList'); list.replaceChildren(); const labels = new Map(this.toolbar());
    for (const id of this.shellDraft.toolbarOrder) { const row = document.createElement('li'), checkbox = document.createElement('input'), label = document.createElement('label'); checkbox.type = 'checkbox'; checkbox.checked = !this.shellDraft.toolbarHidden.includes(id); checkbox.id = `show-${id}`; checkbox.addEventListener('change', () => { this.shellDraft.toolbarHidden = this.shellDraft.toolbarHidden.filter(item => item !== id); if (!checkbox.checked) this.shellDraft.toolbarHidden.push(id); }); label.textContent = labels.get(id); label.htmlFor = checkbox.id; label.className = 'preference-label'; row.append(checkbox, label); this.moveButtons(row, this.shellDraft.toolbarOrder, id, () => this.renderToolbar()); list.append(row); }
  }
  async savePlaces(event) {
    event.preventDefault(); const form = event.currentTarget, identity = this.draftIdentity;
    if (identity !== (this.saved.workspaceIdentity || '')) { document.getElementById('placesPreferencesError').textContent = 'SSH 连接已改变，请关闭并重新打开设置。'; return; }
    if (!identity) { document.getElementById('placesPreferencesError').textContent = '请先连接 SSH。'; return; }
    const input = { ...this.draft, logPath: document.getElementById('settingsLogPath').value.trim(), trashPath: document.getElementById('settingsTrashPath').value.trim() };
    for (const control of form.elements) control.disabled = true;
    try { const result = await this.options.savePlaces(input, identity); this.options.apply(result); document.getElementById('placesPreferencesError').textContent = ''; this.options.notify('目录与侧栏已保存'); }
    catch (error) { document.getElementById('placesPreferencesError').textContent = error.message; }
    finally { for (const control of form.elements) control.disabled = false; this.renderPlaces(); }
  }
  async saveShell(event) {
    event.preventDefault(); const form = event.currentTarget; for (const control of form.elements) control.disabled = true;
    try { const result = await this.options.saveShell({ ...this.shellDraft, clockMode: document.getElementById('settingsClockMode').value }); this.options.apply(result); document.getElementById('shellPreferencesError').textContent = ''; this.options.notify('上栏设置已保存'); }
    catch (error) { document.getElementById('shellPreferencesError').textContent = error.message; }
    finally { for (const control of form.elements) control.disabled = false; this.renderToolbar(); }
  }
};
