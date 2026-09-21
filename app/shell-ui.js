'use strict';
window.DesktopShell = class DesktopShell {
  constructor(options) {
    this.options = options; this.history = []; this.preferences = {}; this.monthOffset = 0;
    const actions = document.querySelector('.toolbar-actions');
    const exit = document.createElement('button'); exit.id = 'exitButton'; exit.className = 'toolbar-icon'; exit.title = '退出'; exit.setAttribute('aria-label', '退出'); exit.append(options.icon('Power')); actions.append(exit);
    exit.addEventListener('click', () => Promise.resolve(options.quit()).catch(error => options.notify(error.message)));
    this.panel = document.createElement('section'); this.panel.id = 'notificationPanel'; this.panel.className = 'notification-panel'; this.panel.hidden = true; this.panel.setAttribute('aria-label', '通知与日历');
    this.panel.innerHTML = '<div class="notification-column"><header><h2>通知</h2><button type="button" class="clear-notifications">清除</button></header><div class="notification-history" tabindex="0" aria-label="历史通知"></div><footer>本次运行的通知</footer></div><div class="notification-calendar"><header><button type="button" class="previous-month" aria-label="上个月">‹</button><strong></strong><button type="button" class="next-month" aria-label="下个月">›</button></header><div class="calendar-weekdays"></div><div class="calendar-days"></div><p class="calendar-zone"></p></div>';
    document.body.append(this.panel);
    this.toast = document.createElement('aside'); this.toast.id = 'notificationToast'; this.toast.className = 'notification-toast'; this.toast.hidden = true; this.toast.setAttribute('role', 'status'); this.toast.innerHTML = '<span></span><button type="button" aria-label="关闭通知">×</button>'; document.body.append(this.toast);
    this.toast.querySelector('button').addEventListener('click', () => { this.toast.hidden = true; options.layout(); });
    const clock = document.getElementById('serverClock');
    clock.addEventListener('click', () => this.toggle()); clock.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); this.toggle(); } });
    this.panel.querySelector('.clear-notifications').addEventListener('click', () => { this.history = []; this.renderHistory(); });
    for (const [selector, delta] of [['.previous-month', -1], ['.next-month', 1]]) this.panel.querySelector(selector).addEventListener('click', () => { this.monthOffset += delta; this.renderCalendar(); });
    document.addEventListener('pointerdown', event => { if (!this.panel.hidden && !event.target.closest('#notificationPanel, #serverClock')) this.close(); }, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !this.panel.hidden) { event.preventDefault(); event.stopImmediatePropagation(); this.close(); clock.focus(); } }, true);
  }
  apply(preferences = {}) {
    this.preferences = preferences;
    const ids = ['connectButton', 'downloadsButton', 'activityButton', 'homeShortcut', 'desktopSettings', 'fullscreen', 'exitButton', 'browserButton'];
    const order = [...new Set([...(preferences.toolbarOrder || []).filter(id => ids.includes(id)), ...ids])];
    const hidden = new Set(preferences.toolbarHidden || ['browserButton', 'exitButton']);
    const actions = document.querySelector('.toolbar-actions');
    for (const id of order) { const button = document.getElementById(id); if (button) { button.hidden = hidden.has(id); actions.append(button); } }
    document.getElementById('connection').hidden = hidden.has('connectButton');
    document.getElementById('serverClock').dataset.mode = preferences.clockMode === 'detailed' ? 'detailed' : 'compact';
  }
  formatClock(anchor, date) {
    if (this.preferences.clockMode === 'detailed') return `${anchor.formatter.format(date)} · ${anchor.label}`;
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: anchor.formatter.resolvedOptions().timeZone }).format(date).replace(',', '');
  }
  add(text, { title = 'Remote Desktop', action, popup = true } = {}) {
    text = String(text || '').slice(0, 12000);
    if (!text || /(?:正在.*…|已刷新 |等待.*…)/.test(text)) return;
    if (this.history.at(-1)?.text === text && Date.now() - this.history.at(-1).time < 2000) return;
    this.history.push({ title, text, action, time: Date.now() }); this.history = this.history.slice(-200);
    if (!this.panel.hidden) this.renderHistory();
    if (popup && this.panel.hidden) {
      document.getElementById('activityToast').hidden = true;
      this.toast.querySelector('span').textContent = text; this.toast.hidden = false;
      this.toast.getAnimations().forEach(animation => animation.cancel()); if (!matchMedia('(prefers-reduced-motion: reduce)').matches) this.toast.animate([{ opacity: 0, transform: 'translate(-50%, -25px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 180, easing: 'ease-out' });
      clearTimeout(this.timer); this.timer = setTimeout(() => { this.toast.hidden = true; this.options.layout(); }, 4500); this.options.layout();
    }
  }
  close() { this.panel.hidden = true; document.getElementById('serverClock').setAttribute('aria-expanded', 'false'); this.options.layout(); }
  toggle() {
    if (!this.panel.hidden) { this.close(); return; }
    if (document.querySelector('dialog:modal')) return;
    this.panel.hidden = false; this.toast.hidden = true; document.getElementById('activityToast').hidden = true;
    document.getElementById('serverClock').setAttribute('aria-expanded', 'true'); this.monthOffset = 0;
    this.renderHistory(); this.renderCalendar(); this.options.layout();
  }
  renderHistory() {
    const list = this.panel.querySelector('.notification-history'); list.replaceChildren();
    if (!this.history.length) { const empty = document.createElement('p'); empty.className = 'notification-empty'; empty.textContent = '暂无通知'; list.append(empty); }
    for (const entry of this.history) {
      const item = document.createElement('article'), icon = this.options.icon('Bell'), body = document.createElement('div'), title = document.createElement('strong'), text = document.createElement('p'), time = document.createElement('time');
      title.textContent = entry.title; text.textContent = entry.text; time.dateTime = new Date(entry.time).toISOString(); time.textContent = this.options.formatTime(entry.time);
      body.append(title, text, time); if (entry.action) { const button = document.createElement('button'); button.textContent = '实时监听'; button.addEventListener('click', () => { this.close(); entry.action(); }); body.append(button); }
      item.append(icon, body); list.append(item);
    }
    list.scrollTop = list.scrollHeight;
  }
  renderCalendar() {
    const { date, zone } = this.options.calendar();
    const month = new Date(Date.UTC(date.year, date.month - 1 + this.monthOffset, 1));
    this.panel.querySelector('.notification-calendar strong').textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(month);
    this.panel.querySelector('.calendar-zone').textContent = zone;
    this.panel.querySelector('.calendar-weekdays').replaceChildren(...['一', '二', '三', '四', '五', '六', '日'].map(label => { const span = document.createElement('span'); span.textContent = label; return span; }));
    const days = this.panel.querySelector('.calendar-days'); days.replaceChildren();
    const start = new Date(month); start.setUTCDate(1 - (month.getUTCDay() + 6) % 7);
    for (let index = 0; index < 42; index++) { const day = new Date(start); day.setUTCDate(start.getUTCDate() + index); const cell = document.createElement('span'); cell.textContent = day.getUTCDate(); cell.classList.toggle('outside-month', day.getUTCMonth() !== month.getUTCMonth()); cell.classList.toggle('today', day.getUTCFullYear() === date.year && day.getUTCMonth() + 1 === date.month && day.getUTCDate() === date.day); days.append(cell); }
  }
};
