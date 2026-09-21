'use strict';
// Local, fixed SVG artwork for application launchers. No remote SVG is parsed.
window.RemoteApplicationIcons = (() => {
  const shapes = {
    folder: '<path fill="#c88334" d="M4 10a3 3 0 0 1 3-3h9l5 5h20a3 3 0 0 1 3 3v23a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/><path fill="#edb65d" d="M4 17h40v21a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/><path fill="#f7cf87" d="M5 17h38v4H5z"/>',
    browser: '<circle cx="24" cy="24" r="21" fill="#429bd7"/><path fill="#8bdac2" d="m12 8 7 2 3 7-5 3-1 7-5-1-6-9zm20-2 8 8-2 7-7 2-1 7-7 3-2 9-5-8 2-10 7-4 2-8z"/><path d="M6 30c7 9 22 15 34 2" fill="none" stroke="#2a75bd" stroke-width="4"/>',
    transfer: '<rect x="4" y="4" width="40" height="40" rx="9" fill="#8161ae"/><path fill="#f3eaff" d="m16 10-9 11h6v15h6V21h6zm16 28 9-11h-6V12h-6v15h-6z"/>',
    activity: '<rect x="3" y="6" width="42" height="35" rx="6" fill="#4b8e71"/><path fill="#c8f3c7" d="M7 26h8l5-14 8 23 4-9h9v-4H29l-1 3-8-23-8 20H7z"/>',
    htop: '<rect x="3" y="5" width="42" height="38" rx="6" fill="#454d59"/><path fill="#6ecb8c" d="M9 24h7v12H9z"/><path fill="#e4b86a" d="M20 16h7v20h-7z"/><path fill="#e78970" d="M31 10h7v26h-7z"/>',
    editor: '<path fill="#63accc" d="M9 3h21l10 10v30H9z"/><path fill="#b9e2ef" d="M30 3v10h10z"/><path d="m20 21-7 6 7 6m10-12 7 6-7 6m-3-13-5 17" fill="none" stroke="#164d69" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
    image: '<rect x="3" y="5" width="42" height="38" rx="6" fill="#ad729e"/><rect x="7" y="9" width="34" height="28" rx="2" fill="#e8d4e3"/><circle cx="32" cy="17" r="5" fill="#e6b555"/><path fill="#6fa788" d="M7 35 18 20l9 10 6-7 8 12v2H7z"/>',
    video: '<rect x="3" y="4" width="42" height="40" rx="7" fill="#bf8854"/><path fill="#e9ba7b" d="M3 12h42v24H3z"/><path fill="#fff2da" d="m20 15 14 9-14 9z"/><path fill="#6a4b35" d="M9 7h5v3H9zm12 0h5v3h-5zm12 0h5v3h-5zM9 38h5v3H9zm12 0h5v3h-5zm12 0h5v3h-5z"/>',
    settings: '<path fill="#a7adb5" d="m20 2 8 0 2 6 5 3 6-1 4 7-4 5v5l4 5-4 7-6-1-5 3-2 6h-8l-2-6-5-3-6 1-4-7 4-5v-5l-4-5 4-7 6 1 5-3z"/><circle cx="24" cy="24" r="11" fill="#646f80"/><circle cx="24" cy="24" r="6" fill="#dce2e7"/>',
    terminal: '<rect x="3" y="5" width="42" height="38" rx="6" fill="#495363"/><rect x="6" y="9" width="36" height="30" rx="3" fill="#202b38"/><path d="m12 17 8 7-8 7m12 0h10" fill="none" stroke="#dbe8ed" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
    programs: '<rect x="5" y="5" width="9" height="9" rx="2" fill="#eda664"/><rect x="20" y="5" width="9" height="9" rx="2" fill="#7bb6dc"/><rect x="35" y="5" width="9" height="9" rx="2" fill="#9bc584"/><rect x="5" y="20" width="9" height="9" rx="2" fill="#ab8ccf"/><rect x="20" y="20" width="9" height="9" rx="2" fill="#e0b768"/><rect x="35" y="20" width="9" height="9" rx="2" fill="#df8b86"/><rect x="5" y="35" width="9" height="9" rx="2" fill="#72b9ba"/><rect x="20" y="35" width="9" height="9" rx="2" fill="#cb8cb1"/><rect x="35" y="35" width="9" height="9" rx="2" fill="#a9adb6"/>'
  };
  const aliases = { home: 'folder', workbench: 'editor', vim: 'editor', shell: 'terminal' };
  return { create(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 48 48'); svg.setAttribute('class', 'application-art'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = shapes[aliases[name] || name] || shapes.folder;
    return svg;
  } };
})();
