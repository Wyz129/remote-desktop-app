'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { WebSocketServer } = require('ws');
const { JupyterClient, endpointUrl } = require('../lib/jupyter-client.cjs');
const { SshBackend } = require('../lib/ssh-backend.cjs');
const { createSshFixture } = require('./helpers/ssh-fixture.cjs');

test('Jupyter REST and WebSocket execute through SSH with token, outputs and kernel lifecycle', { timeout: 20000 }, async t => {
  const requests = [], messages = []; let interrupted = false;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    if (req.headers.authorization !== 'token secret-token') return res.writeHead(403).end('denied');
    res.setHeader('Content-Type','application/json');
    if (req.url === '/base/api/kernelspecs') return res.end(JSON.stringify({ kernelspecs: { python3: { spec: { display_name:'Python 3',language:'python' } } } }));
    if (req.url === '/base/api/kernels' && req.method === 'GET') return res.end(JSON.stringify([{id:'fixture-kernel',name:'python3',execution_state:'idle'}]));
    if (req.url === '/base/api/kernels' && req.method === 'POST') return res.end(JSON.stringify({id:'fixture-kernel',name:'python3'}));
    if (req.url.endsWith('/interrupt')) interrupted = true;
    res.end('{}');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    assert.equal(req.headers.authorization, 'token secret-token'); assert.ok(req.url.startsWith('/base/api/kernels/fixture-kernel/channels?session_id='));
    socket.on('message', bytes => {
      const request = JSON.parse(bytes); messages.push(request); const parent_header = request.header;
      const send = (type, content, channel='iopub') => socket.send(JSON.stringify({header:{msg_type:type},parent_header,channel,content}));
      send('stream',{name:'stdout',text:'hello\n'}); send('display_data',{data:{'text/plain':'42'},metadata:{}});
      send('status',{execution_state:'idle'}); send('execute_reply',{status:'ok',execution_count:7},'shell');
    });
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const fixture=await createSshFixture({forwardTargets:{'jupyter.internal:8888':server.address().port}}), backend=new SshBackend();
  await backend.connect(fixture.config);
  const client = new JupyterClient(backend.client,'http://jupyter.internal:8888/base/?token=secret-token');
  t.after(async()=>{client.close(); for(const socket of wss.clients)socket.terminate(); await new Promise(resolve=>wss.close(resolve)); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));await backend.disconnect();await fixture.close();});
  const info=await client.info(); assert.equal(info.endpoint,'http://jupyter.internal:8888/base/');assert.equal(info.kernelspecs[0].name,'python3');
  await client.start('python3'); const outputs=[];client.on('output',output=>outputs.push(output));
  const result=await client.execute('print("hello")','cell-a');assert.equal(result.execution_count,7);assert.deepEqual(outputs.map(x=>x.type),['stream','display_data']);assert.equal(outputs[0].cellId,'cell-a');
  assert.equal(messages[0].content.allow_stdin,false);assert.equal(messages[0].header.msg_type,'execute_request');assert.ok(fixture.calls.forwards.length>=1);assert.ok(fixture.calls.forwards.every(item=>item.destIP==='jupyter.internal'&&item.destPort===8888));
  await client.interrupt();assert.ok(interrupted);await client.restart();await client.shutdown();assert.equal(client.kernelId,null);
  assert.ok(requests.some(request=>request.method==='DELETE'));assert.ok(requests.every(request=>!request.url.includes('secret-token')));
});

test('Jupyter rejects credential URLs, unsupported protocols, redirects and unauthenticated services', async t=>{
  assert.throws(()=>endpointUrl('file:///etc/passwd'));assert.throws(()=>endpointUrl('http://user:password@localhost/'));
  const server=http.createServer((_req,res)=>res.writeHead(302,{Location:'/login'}).end());await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const ssh={forwardOut(_a,_b,_host,_port,callback){const socket=net.connect(server.address().port,'127.0.0.1',()=>callback(null,socket));}};
  const client=new JupyterClient(ssh,'http://localhost:8888');t.after(async()=>{client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  await assert.rejects(client.info(),/HTTP 302/);assert.throws(()=>client.execute('1','a'),/先启动/);
});
