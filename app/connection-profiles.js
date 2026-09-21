'use strict';
window.RemoteConnectionProfiles = Object.freeze({
  mount(api, options = {}) {
    const $ = id => document.getElementById(id);
    let profiles = [], selected = '', aliasAuto = false, legacySaved = false;
    const clearSecrets = () => { $('sshPassword').value = ''; $('sshPassphrase').value = ''; $('reconnectPassphrase').value = ''; };
    const updateHeading = () => {
      $('serverDisplayName').textContent = $('sshAlias').value.trim() || ($('sshHost').value.trim() ? 'Unknown Server' : 'Remote Desktop');
      $('serverDisplayAddress').textContent = $('sshHost').value ? `${$('sshHost').value}:${$('sshPort').value || 22}` : '选择服务器以登录';
    };
    function fill(profile = {}) {
      selected = profile.id || ''; aliasAuto = !profile.alias || profile.aliasAuto === true; clearSecrets();
      for (const [field, value] of Object.entries({ sshHost: profile.host || '', sshPort: profile.port || 22, sshUsername: profile.username || '', sshAlias: profile.alias || '', sshPrivateKey: profile.privateKeyPath || '' })) $(field).value = value;
      $('serverProfile').value = selected;
      $('connectionError').textContent = ''; updateHeading();
    }
    function refresh(saved, apply = true) {
      profiles = Array.isArray(saved.serverProfiles) ? saved.serverProfiles : [];
      legacySaved = Boolean(saved.host && saved.username);
      $('serverProfile').replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择服务器'; $('serverProfile').append(placeholder);
      for (const profile of profiles) {
        const option = document.createElement('option'); option.value = profile.id;
        option.textContent = `${profile.alias || 'Unknown Server'} · ${profile.username}@${profile.host}:${profile.port}`;
        $('serverProfile').append(option);
      }
      const profile = profiles.find(item => item.id === saved.selectedServerId) || profiles.at(-1);
      if (apply) fill(profile || saved);
      else { selected = profile?.id || selected; $('serverProfile').value = selected; if (profile) { $('sshAlias').value = profile.alias || 'Unknown Server'; aliasAuto = profile.aliasAuto === true; } updateHeading(); }
    }
    const input = () => ({ id: selected || undefined, profileId: selected || undefined, host: $('sshHost').value.trim(), port: Number($('sshPort').value), username: $('sshUsername').value.trim(), alias: $('sshAlias').value.trim(), aliasAuto, privateKeyPath: $('sshPrivateKey').value || '' });
    $('serverProfile').addEventListener('change', () => { fill(profiles.find(profile => profile.id === $('serverProfile').value)); $('sshPassword').focus(); });
    $('newServer').addEventListener('click', () => { fill(); $('sshHost').focus(); });
    for (const id of ['sshHost', 'sshPort', 'sshAlias']) $(id).addEventListener('input', updateHeading);
    $('sshAlias').addEventListener('input', () => { aliasAuto = !$('sshAlias').value.trim(); });
    $('saveServer').addEventListener('click', async () => {
      $('saveServer').disabled = true; $('connectionError').textContent = '';
      try {
        if (!$('connectionForm').reportValidity()) return;
        refresh(await api.saveServer(input()), false); clearSecrets(); options.onSaved?.();
        $('connectionHint').textContent = '配置已保存，请输入密码登录。';
      }
      catch (error) { $('connectionError').textContent = error.message; }
      finally { $('saveServer').disabled = false; }
    });
    $('connectionDialog').addEventListener('close', clearSecrets);
    return { refresh, input, clearSecrets, fill, updateHeading, hasSaved: () => profiles.length > 0 || Boolean(selected) || legacySaved, current: () => profiles.find(profile => profile.id === selected) };
  }
});
