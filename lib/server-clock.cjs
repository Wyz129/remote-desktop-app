'use strict';

const SERVER_CLOCK_LIMIT = 8 * 1024;
const SERVER_CLOCK_TIMEOUT = 8000;

// One date invocation keeps the epoch, wall clock and UTC offset in the same
// second. TZ is data only; it is never sourced or evaluated as shell code.
const SERVER_CLOCK_COMMAND = [
  '# remote-desktop-server-clock-v1',
  'clock_user=$(id -un) || exit 1',
  'clock_host=$(hostname) || exit 1',
  "clock_snapshot=$(date '+%s|%Y-%m-%dT%H:%M:%S|%z|%Z') || exit 1",
  'clock_zone=',
  'if [ "${TZ+x}" = x ]; then',
  '  clock_zone=${TZ:-UTC}',
  'else',
  '  if command -v readlink >/dev/null 2>&1; then',
  '    clock_link=$(readlink /etc/localtime 2>/dev/null)',
  '    case "$clock_link" in */zoneinfo/*) clock_zone=${clock_link#*/zoneinfo/};; esac',
  '  fi',
  '  if [ -z "$clock_zone" ] && [ -r /etc/timezone ]; then clock_zone=$(cat /etc/timezone 2>/dev/null); fi',
  'fi',
  "printf '%s\\000' \"$clock_user\" \"$clock_host\" \"$clock_snapshot\" \"$clock_zone\"",
].join('\n');

function malformed() { return new Error('服务器返回的本地时间或时区格式无效。'); }

function parseServerInfo(text) {
  // Four NUL-terminated fields: user, host, date snapshot, timezone source.
  const fields = text.split('\0');
  if (fields.length !== 5 || fields[4] !== '') throw malformed();
  const [username, hostname, snapshot, zone] = fields.slice(0, 4).map(value => value.trim());
  if (!username || !hostname || username.length > 256 || hostname.length > 256 || zone.length > 512 || [username, hostname, snapshot, zone].some(value => /[\x00-\x1f\x7f]/.test(value))) throw malformed();
  const clock = snapshot.split('|');
  if (clock.length !== 4) throw malformed();
  const [epoch, localTime, utcOffset, abbreviation] = clock;
  if (!/^-?\d+$/.test(epoch) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(localTime) || !/^[+-](?:[01]\d|2[0-3])[0-5]\d$/.test(utcOffset) || abbreviation.length > 64) throw malformed();
  const epochMs = Number(epoch) * 1000;
  const utcOffsetMinutes = (utcOffset[0] === '-' ? -1 : 1) * (Number(utcOffset.slice(1, 3)) * 60 + Number(utcOffset.slice(3, 5)));
  const wallTime = new Date(epochMs + utcOffsetMinutes * 60_000);
  if (!Number.isSafeInteger(epochMs) || !Number.isFinite(wallTime.getTime()) || wallTime.toISOString().slice(0, 19) !== localTime) throw malformed();

  const candidate = zone.replace(/^:/, '').replace(/^.*\/zoneinfo\//, '').replace(/^(?:posix|right)\//, '') || abbreviation;
  let timeZone = null;
  // Abbreviations such as CST are ambiguous. Use the measured offset for
  // them, unknown POSIX TZ rules, or client/server timezone-data differences.
  if (candidate.includes('/') || /^(?:UTC|GMT)$/i.test(candidate)) {
    try {
      const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: candidate, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      const parts = Object.fromEntries(formatter.formatToParts(new Date(epochMs)).map(part => [part.type, part.value]));
      const formatted = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
      if (formatted === localTime) timeZone = formatter.resolvedOptions().timeZone;
    } catch { /* Keep the server offset; never substitute the client timezone. */ }
  }
  const offsetLabel = `UTC${utcOffset.slice(0, 3)}:${utcOffset.slice(3)}`;
  const timeZoneLabel = candidate ? `${candidate} (${offsetLabel})` : offsetLabel;
  return { type: 'serverInfo', remote: true, available: true, username, hostname, epochMs, localTime, timeZone, utcOffset, utcOffsetMinutes, timeZoneLabel };
}

async function getServerInfo(backend) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(new Error('读取服务器本地时间超时，请重试。')); controller.abort(); }, SERVER_CLOCK_TIMEOUT);
  });
  const query = (async () => {
    const { stream, completion } = await backend._execStream(SERVER_CLOCK_COMMAND, controller.signal);
    const chunks = []; let size = 0;
    const reading = (async () => {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > SERVER_CLOCK_LIMIT) throw new Error('服务器时间输出超过 8 KiB 安全上限。');
        chunks.push(Buffer.from(chunk));
      }
    })();
    await Promise.all([reading, completion]);
    return parseServerInfo(Buffer.concat(chunks).toString('utf8'));
  })();
  try { return await Promise.race([query, timeout]); }
  catch (error) { controller.abort(); throw error; }
  finally { clearTimeout(timer); }
}

module.exports = { getServerInfo, SERVER_CLOCK_COMMAND };
