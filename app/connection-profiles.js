'use strict';
window.RemoteConnectionProfiles = Object.freeze({
  mount(api) {
    const $ = id => document.getElementById(id);
    let profiles = [], selected = '';
    const clearSecrets = () => { $('sshPassword').value = ''; $('sshPassphrase').value = ''; };
    const updateHeading = () => {
      $('serverDisplayName').textContent = $('sshAlias').value.trim() || $('sshHost').value.trim() || '添加服务器';
      $('serverDisplayAddress').textContent = $('sshHost').value ? `${$('sshHost').value}:${$('sshPort').value || 22}` : '配置服务器后登录';
    };
    function fill(profile = {}) {
      selected = profile.id || ''; clearSecrets();
      for (const [field, value] of Object.entries({ sshHost: profile.host || '', sshPort: profile.port || 22, sshUsername: profile.username || '', sshAlias: profile.alias || '', sshPrivateKey: profile.privateKeyPath || '' })) $(field).value = value;
      $('serverProfile').value = selected; $('connectionAdvanced').open = !profile.host;
      $('connectionError').textContent = ''; updateHeading();
    }
    function refresh(saved, apply = true) {
      profiles = Array.isArray(saved.serverProfiles) ? saved.serverProfiles : [];
      $('serverProfile').replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '选择服务器'; $('serverProfile').append(placeholder);
      for (const profile of profiles) {
        const option = document.createElement('option'); option.value = profile.id;
        option.textContent = `${profile.alias || profile.host} · ${profile.username}@${profile.host}:${profile.port}`;
        $('serverProfile').append(option);
      }
      const profile = profiles.find(item => item.id === saved.selectedServerId) || profiles.at(-1);
      if (apply) fill(profile || saved);
      else { selected = profile?.id || selected; $('serverProfile').value = selected; updateHeading(); }
    }
    const input = () => ({ id: selected || undefined, profileId: selected || undefined, host: $('sshHost').value.trim(), port: Number($('sshPort').value), username: $('sshUsername').value.trim(), alias: $('sshAlias').value.trim(), privateKeyPath: $('sshPrivateKey').value || '' });
    $('serverProfile').addEventListener('change', () => { fill(profiles.find(profile => profile.id === $('serverProfile').value)); $('sshPassword').focus(); });
    $('newServer').addEventListener('click', () => { fill(); $('sshHost').focus(); });
    for (const id of ['sshHost', 'sshPort', 'sshAlias']) $(id).addEventListener('input', updateHeading);
    $('saveServer').addEventListener('click', async () => {
      $('saveServer').disabled = true; $('connectionError').textContent = '';
      try { refresh(await api.saveServer(input()), false); $('connectionHint').textContent = '服务器配置已保存；密码仅用于本次登录。'; $('connectionAdvanced').open = false; }
      catch (error) { $('connectionError').textContent = error.message; }
      finally { $('saveServer').disabled = false; }
    });
    $('connectionForm').addEventListener('invalid', () => { $('connectionAdvanced').open = true; }, true);
    $('connectionDialog').addEventListener('close', clearSecrets);
    return { refresh, input, clearSecrets };
  }
});
