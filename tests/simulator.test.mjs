import '../scripts/fonts.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createStudio}from '../work/simulator/studio/index.js';import {renderScenePng}from '../work/simulator/studio/host-png.js';import {Authority}from '../scripts/lua-vm.mjs';
const load=mode=>createStudio(JSON.parse(fs.readFileSync(`outputs/sixnimmt-${mode}.save.json`)));
// Publishes one seat's view exactly the way server-graph/src/main.ts does: public
// state in Level custom variables (nimmt_pub/nimmt_text), the private hand in the
// seat's own PlayerSelf.nimmt_me, then nimmt_rev last (the variable clients listen
// to). Layout must match lua/client.lua viewFromVars() and main.ts PUB_* offsets.
const pad=(a,n,z=0)=>Array.from({length:n},(_,i)=>a[i]??z);
let rev=0;
// The server's private per-seat key (written into nimmt_me[11]); every NimmtAct must echo it.
const KEY=seat=>1000+seat*7;
const ACT=(sig)=>({seat:sig.values[0],key:sig.values[1],kind:sig.values[2],token:sig.values[3],value:sig.values[4]});
function publish(studio,v,extra={}){
 const bot=extra.bot||[],voted=extra.voted||[];
 const pub=[v.n,v.handNo,v.round,v.token,v.revision,v.cursor??0,v.waiting??0,extra.humans??v.n,extra.votesEnd??0,extra.votesLeave??0,30,extra.settings??3,
  ...v.rows.flatMap(r=>pad(r,5)),...pad(v.scores,8),...pad(v.counts,8),...pad(v.ready.map(x=>x?1:0),8),...pad(bot,8),...pad(voted,8),
  ...pad(v.queue.map(q=>q.card),8),...pad(v.queue.map(q=>q.player),8),...pad(v.winners,8)];
 assert.equal(pub.length,96);
 studio.playServerSet('Level','nimmt_pub',pub);
 studio.playServerSet('Level','nimmt_text',[v.phase,v.mode,v.endReason??'',...pad(v.events.slice(-3),3,'')]);
 studio.playServerSet('PlayerSelf','nimmt_me',[v.seat,...pad(v.hand,10),KEY(v.seat)]);
 studio.playServerSet('Level','nimmt_rev',++rev);
}
function clean(s){assert.ok(!s.mountError,s.mountError);assert.deepEqual(s.logs.filter(x=>x.level==='lua-error'),[]);}
test('练习版实际 Lua 启动、开局设置、点击、超时推进并结算',()=>{const st=load('practice');try{clean(st.playStart({view:true}));st.playClick('LaunchStart');st.playClick('SetupBegin');for(let i=0;i<8;i++)st.playStep(0.5);let snap=st.playGet({view:true});clean(snap);fs.writeFileSync('outputs/practice-start.png',renderScenePng(snap.scene,1280,720).data);st.playClick('Hand1');st.playClick('Confirm');for(let i=0;i<1400;i++)st.playStep(0.5);snap=st.playGet({view:true});clean(snap);assert.match(snap.scene.nodes.find(n=>n.name==='ResultReason').text,/十轮已全部完成|已有玩家达到 66 分/);fs.writeFileSync('outputs/practice-finish.png',renderScenePng(snap.scene,1280,720).data);}finally{st.playStop();}});
test('八个独立 Lua 客户端读取各自的自定义变量快照，用私有密钥发送选牌意图',()=>{const a=new Authority(8,19);const clients=[];try{for(let p=1;p<=8;p++){const s=load('network');clients.push(s);clean(s.playStart());publish(s,a.view(p));const snap=s.playGet({view:true});clean(snap);assert.equal(snap.scene.nodes.find(n=>n.name==='Hand1Text').text,String(a.view(p).hand[0]));assert.match(snap.scene.nodes.find(n=>n.name==='Hand1TextHeads').text,/^×[12357]$/);s.playClick('Hand1');s.playClick('Confirm');const signal=s.playGet().server.inbound.find(x=>x.name==='NimmtAct'&&x.values[2]===1);assert.ok(signal);assert.deepEqual(signal.values,[p,KEY(p),1,a.view(p).token,a.view(p).hand[0]]);const act=ACT(signal);assert.equal(act.key,KEY(act.seat));assert.equal(a.action(act.seat,'submit',act.value,act.token)[0],true);}assert.equal(a.view(1).phase,'reveal');}finally{clients.forEach(s=>s.playStop());a.close();}});

test('八客户端完整十轮：真实 Lua 点击 → 信号 → 权威规则 → 自定义变量快照',()=>{
 const a=new Authority(8,73);const clients=Array.from({length:8},()=>load('network'));const consumed=Array(8).fill(0);let rounds=0;
 const broadcast=()=>clients.forEach((s,i)=>{publish(s,a.view(i+1));clean(s.playGet());});
 const click=(p,name)=>{const s=clients[p-1];s.playClick(name);const incoming=s.playGet().server.inbound;for(const sig of incoming.slice(consumed[p-1])){if(sig.name!=='NimmtAct')continue;const x=ACT(sig);assert.equal(x.seat,p);assert.equal(x.key,KEY(p),'key must be the private one');if(x.kind===1||x.kind===2)assert.equal(a.action(p,x.kind===1?'submit':'choose',x.value,x.token)[0],true);}consumed[p-1]=incoming.length;};
 try{
  clients.forEach(s=>clean(s.playStart()));broadcast();
  for(let step=0;step<180;step++){
   const v=a.view(1);if(v.phase==='gameOver')break;
   if(v.phase==='select'){
    rounds++;for(let p=1;p<=8;p++){click(p,'Hand1');click(p,'Confirm');broadcast();}
   }else if(v.phase==='chooseRow'){click(v.waiting,'RowAction1');broadcast();}
   else {a.step();broadcast();}
   assert.equal(a.check(),true);
  }
  assert.equal(rounds,10);assert.equal(a.view(1).phase,'gameOver');
  clients.forEach((s,i)=>{const scene=s.playGet({view:true}).scene;assert.equal(scene.nodes.find(n=>n.name==='ResultReason').text,'十轮已全部完成');assert.deepEqual(a.view(i+1).hand,[]);});
  fs.writeFileSync('outputs/eight-client-result.json',JSON.stringify({players:8,rounds,scores:a.view(1).scores,winners:a.view(1).winners,scope:'Local independent Lua VMs + reference authority; not official game multiplayer'},null,2));
 }finally{clients.forEach(s=>s.playStop());a.close();}
});


test('多人客户端：服务端准备人数、准备/投票意图、电脑/离线席位显示',()=>{
 const s=load('network');const a=new Authority(4,5);
 try{
  clean(s.playStart());
  // lobby: the server has seated this client as seat 1 of 2 humans (one already ready)
  const lobby={...a.view(1),phase:'lobby',n:2,hand:[],ready:[false,true],scores:[0,0],counts:[0,0],queue:[],winners:[]};
  publish(s,lobby);s.playClick('LaunchStart');
  let setup=s.playGet({view:true});clean(setup);assert.equal(setup.scene.nodes.find(x=>x.name==='ReadyToggleText').text,'已准备 1/2');
  s.playClick('BotsMinus');s.playClick('SetupBegin');
  const acts=s.playGet().server.inbound.filter(x=>x.name==='NimmtAct').map(ACT);
  assert.deepEqual(acts.find(x=>x.kind===5),{seat:1,key:KEY(1),kind:5,token:a.view(1).token,value:10*2},'settings: value = 10*bots + 100*mode');
  const ready=acts.find(x=>x.kind===4);
  assert.deepEqual(ready,{seat:1,key:KEY(1),kind:4,token:a.view(1).token,value:1+10*2+0},'ready: value = ready + 10*bots + 100*mode');
  publish(s,a.view(1),{humans:2,bot:[0,1,2,0],votesEnd:1,voted:[1,0,0,0]});
  const snap=s.playGet({view:true});clean(snap);const node=n=>snap.scene.nodes.find(x=>x.name===n);
  assert.match(node('Player2').text,/^电脑2$/);assert.match(node('Player3').text,/^玩家3$/);assert.ok(node('Player3Bot'),'托管 shown by a bot icon');assert.match(node('Player4').text,/^玩家4$/);
 }finally{s.playStop();a.close();}
});

test('整合 GIA 能被沙箱重新导入并启动（不等于真机导入验收）',()=>{
 const s=createStudio();try{const result=s.importData('gia',fs.readFileSync('outputs/sixnimmt-practice.gia').toString('base64'));assert.ok(result);clean(s.playStart());s.playClick('LaunchStart');s.playClick('SetupBegin');for(let i=0;i<8;i++)s.playStep(0.5);clean(s.playGet());}finally{s.playStop();}
});
