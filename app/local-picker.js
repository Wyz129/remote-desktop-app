'use strict';
const status = document.getElementById('status');
const select = document.getElementById('select');
window.localPicker.onState(value => { status.textContent = value.text; select.disabled = !value.ready; });
select.addEventListener('click', async () => { select.disabled = true; try { await window.localPicker.select(); } catch (error) { status.textContent = error.message; select.disabled = false; } });
document.getElementById('cancel').addEventListener('click', () => window.localPicker.cancel().catch(error => { status.textContent = error.message; }));
document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); void window.localPicker.cancel(); } });
