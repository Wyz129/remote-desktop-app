'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workspacePreferences, workspaceLocations, shellPreferences } = require('../lib/interface-preferences.cjs');
test('fixed places survive reordering and invalid stored custom entries are discarded', () => {
  const value=workspacePreferences({placeOrder:['trash','root','trash','unknown'],shortcuts:[{id:'custom-a',label:'公共目录',path:'/srv/a/../projects'},{id:'root',label:'fake',path:'/tmp'}]});
  assert.deepEqual(value.placeOrder,['trash','root','home','desktop','log','custom-a']);
  assert.deepEqual(value.shortcuts,[{id:'custom-a',label:'公共目录',path:'/srv/projects'}]);
  assert.throws(()=>workspacePreferences({logPath:'relative'},true),/绝对路径/);
  assert.throws(()=>workspacePreferences({shortcuts:[{id:'custom-a',label:'x',path:'/a\0b'}]},true),/绝对路径/);
  assert.throws(()=>workspacePreferences({shortcuts:[{id:'custom-a',label:'x',path:'/a'},{id:'custom-a',label:'y',path:'/b'}]},true),/重复/);
});
test('workspace choices are isolated by complete verified server identity', () => {
  const first=JSON.stringify(['a',22,'user','SHA256:a']), second=JSON.stringify(['b',22,'user','SHA256:b']);
  const result=workspaceLocations({[first]:{logPath:'/one'},[second]:{logPath:'/two'},invalid:{logPath:'/ignored'}});
  assert.equal(result[first].logPath,'/one');assert.equal(result[second].logPath,'/two');assert.equal(result.invalid,undefined);
});
test('toolbar defaults hide browser and use compact time while preserving valid custom order', () => {
  assert.deepEqual(shellPreferences().toolbarHidden,['browserButton']); assert.equal(shellPreferences().clockMode,'compact');
  const result=shellPreferences({clockMode:'detailed',toolbarOrder:['exitButton','bogus','exitButton'],toolbarHidden:['browserButton','bogus','browserButton']});
  assert.equal(result.toolbarOrder[0],'exitButton');assert.equal(result.toolbarOrder.length,8);assert.deepEqual(result.toolbarHidden,['browserButton']);assert.equal(result.clockMode,'detailed');
});
