'use strict';

class LocalPicker {
  constructor({ dialog, getParent }) {
    this.dialog = dialog;
    this.getParent = getParent;
    this.pending = null;
    this.generation = 0;
  }

  choose(kind) {
    if (kind === 'directory') return Promise.reject(new Error('上传仅支持选择文件，不支持文件夹。'));
    if (kind && kind !== 'files') return Promise.reject(new Error('无效的本地选择方式。'));
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = this._choose(generation).finally(() => { this.pending = null; });
    return this.pending;
  }

  async _choose(generation) {
    const parent = this.getParent();
    if (parent?.isDestroyed()) return [];
    const parentClosed = () => this.close();
    parent?.once('closed', parentClosed);
    try {
      const result = await this.dialog.showOpenDialog(parent, {
        title: '选择上传文件',
        buttonLabel: '选择文件',
        properties: ['openFile', 'multiSelections']
      });
      // Electron owns the native dialog. Ignore its result if the SSH session or
      // owner was closed while the user was choosing files.
      return result.canceled || generation !== this.generation ? [] : result.filePaths;
    } finally {
      parent?.removeListener('closed', parentClosed);
    }
  }

  close() { this.generation++; }
}

module.exports = { LocalPicker };
