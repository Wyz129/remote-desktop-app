'use strict';

// ssh2 Read/WriteStream sets emitClose=false. Node's finished()/pipeline() may
// complete at EOF/finish while the remote SSH_FXP_CLOSE is still pending.
// Observe ssh2's explicit close acknowledgement as well as errors before any
// consumer starts, so immediate disconnect cannot leave a pending close error.
function closed(stream) {
  const result = new Promise((resolve, reject) => {
    stream.once('close', resolve);
    stream.on('error', reject);
  });
  result.catch(() => {}); // The caller awaits the same promise after streaming.
  return result;
}

async function readBuffer(sftp, target, limit) {
  const stream = sftp.createReadStream(target);
  const close = closed(stream);
  const chunks = []; let size = 0;
  stream.on('data', chunk => {
    size += chunk.length;
    if (size > limit) { stream.destroy(new Error('远程文件超过允许载入的大小。')); return; }
    chunks.push(Buffer.from(chunk));
  });
  await close;
  return Buffer.concat(chunks);
}

module.exports = { closed, readBuffer };
