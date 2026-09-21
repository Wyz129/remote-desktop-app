'use strict';
// Explorer chrome stays separate from directory requests and permission handling.
window.RemoteExplorer = (() => {
  const controllers = new WeakMap();
  function mount(element, { getPath, navigate, focus, icon }) {
    const header = element.querySelector('.titlebar');
    const pathbar = element.querySelector('.pathbar');
    header.insertBefore(pathbar, element.querySelector('.window-controls'));
    element.classList.add('explorer-window');
    const box = element.querySelector('.address-box');
    const slot = element.querySelector('.address-slot');
    const input = element.querySelector('.window-path');
    const breadcrumbs = element.querySelector('.window-breadcrumbs');
    const places = element.querySelector('.explorer-places');
    let frame = 0, currentPath = null, placeSignature = '', disposed = false;

    function fitBreadcrumbs() {
      frame = 0;
      if (disposed || input.hidden === false || !slot.clientWidth) return;
      const trail = breadcrumbs.firstElementChild;
      if (!trail) return;
      const overflow = trail.querySelector('.breadcrumb-overflow');
      const segments = [...trail.querySelectorAll('.breadcrumb-segment')];
      for (const segment of segments) segment.hidden = false;
      overflow.hidden = true;
      trail.classList.remove('has-overflow');
      // Measure the full path without shrinking the current directory, then hide
      // leading ancestors. The final segment may ellipsize only if it alone is wide.
      trail.classList.add('measuring');
      let hidden = 0;
      while (trail.scrollWidth > Math.max(20, slot.clientWidth - 24) && hidden < segments.length - 1) {
        segments[hidden++].hidden = true;
        overflow.hidden = false;
      }
      trail.classList.toggle('has-overflow', hidden > 0);
      trail.classList.remove('measuring');
      overflow.title = hidden ? segments.slice(0, hidden).map(segment => segment.dataset.path).join('\n') + '\n点击编辑完整路径' : '';
    }
    function scheduleFit() {
      if (!frame && !disposed) frame = requestAnimationFrame(fitBreadcrumbs);
    }
    function startEditing() {
      focus();
      input.value = getPath();
      input.removeAttribute('data-dirty');
      input.removeAttribute('aria-invalid');
      input.hidden = false; breadcrumbs.hidden = true; box.classList.add('editing');
      input.focus(); input.select();
    }
    function finishEditing() {
      const wasFocused = document.activeElement === input;
      input.hidden = true; breadcrumbs.hidden = false; box.classList.remove('editing');
      scheduleFit();
      if (wasFocused) element.focus({ preventScroll: true });
    }
    box.addEventListener('pointerdown', event => { event.stopPropagation(); focus(); });
    box.addEventListener('dblclick', event => event.stopPropagation());
    box.addEventListener('click', event => {
      if (event.target.closest('button, input')) return;
      startEditing();
    });
    input.addEventListener('blur', () => {
      if (input.dataset.dirty !== 'true') finishEditing();
    });
    element.addEventListener('keydown', event => {
      if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') || (event.key === 'F4' && !event.altKey)) {
        event.preventDefault(); event.stopPropagation(); startEditing();
      } else if (event.altKey && ['ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key) && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopPropagation();
        const action = { ArrowUp: 'up', ArrowLeft: 'back', ArrowRight: 'forward' }[event.key];
        element.querySelector(`[data-window-action="${action}"]`).click();
      } else if (event.target.closest('.explorer-places, .window-breadcrumbs') && ['Enter', ' ', 'Delete', 'F2'].includes(event.key)) {
        event.stopPropagation();
      }
    });
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(slot);

    function render(path, locations) {
      const home = locations.find(location => location.id === 'home')?.path?.replace(/\/$/, '') || '/';
      const insideHome = path === home || path.startsWith(home === '/' ? '/' : home + '/');
      const pathKey = `${home}\n${path}`;
      if (currentPath !== pathKey) {
        currentPath = pathKey;
        const trail = document.createElement('div'); trail.className = 'breadcrumb-trail';
        const overflow = document.createElement('button'); overflow.type = 'button'; overflow.className = 'breadcrumb-overflow';
        overflow.textContent = '…'; overflow.setAttribute('aria-label', '编辑完整路径'); overflow.hidden = true;
        overflow.addEventListener('click', startEditing); trail.append(overflow);
        const segments = [{ path: insideHome ? home : '/', label: insideHome ? '~' : 'Root' }];
        let parent = insideHome && home !== '/' ? home : '';
        const remainder = insideHome ? path.slice(home.length) : path;
        for (const label of remainder.split('/').filter(Boolean)) { parent += '/' + label; segments.push({ path: parent, label }); }
        segments.forEach((segment, index) => {
          const item = document.createElement('span'); item.className = 'breadcrumb-segment'; item.dataset.path = segment.path;
          if (index) { const separator = document.createElement('span'); separator.className = 'breadcrumb-separator'; separator.textContent = '›'; separator.setAttribute('aria-hidden', 'true'); item.append(separator); }
          const button = document.createElement('button'); button.type = 'button'; button.textContent = segment.label; button.title = segment.path;
          button.dataset.breadcrumbPath = segment.path; button.setAttribute('aria-label', `转到 ${segment.path}`);
          if (index === segments.length - 1) { button.setAttribute('aria-current', 'page'); item.classList.add('current'); }
          button.addEventListener('click', () => { focus(); if (getPath() !== segment.path) navigate(segment.path); });
          item.append(button); trail.append(item);
        });
        breadcrumbs.replaceChildren(trail);
      }
      const signature = JSON.stringify(locations);
      if (signature !== placeSignature) {
        const activeId = document.activeElement?.closest('.explorer-place')?.dataset.placeId;
        const restoreFocus = places.contains(document.activeElement);
        placeSignature = signature;
        places.replaceChildren(...locations.map(location => {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'explorer-place';
          button.dataset.placeId = location.id; button.dataset.placePath = location.path; button.title = `${location.label}\n${location.path}`;
          const label = document.createElement('span'); label.textContent = location.label;
          button.append(icon(location.icon), label);
          button.addEventListener('click', () => { focus(); navigate(location.path); });
          return button;
        }));
        if (restoreFocus) [...places.children].find(button => button.dataset.placeId === activeId)?.focus();
      }
      for (const button of places.children) {
        const selected = button.dataset.placePath === path;
        button.classList.toggle('active', selected);
        if (selected) button.setAttribute('aria-current', 'location'); else button.removeAttribute('aria-current');
      }
      scheduleFit();
    }
    const controller = { render, finishEditing, dispose() { disposed = true; observer.disconnect(); cancelAnimationFrame(frame); controllers.delete(element); } };
    controllers.set(element, controller);
    return controller;
  }
  return {
    mount,
    render(element, path, places) { controllers.get(element)?.render(path, places); },
    finishEditing(element) { controllers.get(element)?.finishEditing(); },
    dispose(element) { controllers.get(element)?.dispose(); }
  };
})();
