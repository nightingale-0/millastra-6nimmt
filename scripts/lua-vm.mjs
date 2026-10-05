import {createRequire} from 'node:module';import fs from 'node:fs';
const require=createRequire(new URL('../work/simulator/package.json',import.meta.url));
const {lua,lauxlib,lualib,to_luastring,to_jsstring}=require('fengari');
export class LuaVM{
 constructor(){this.L=lauxlib.luaL_newstate();lualib.luaL_openlibs(this.L);this.exec('Core=(function()\n'+fs.readFileSync(new URL('../lua/core.lua',import.meta.url),'utf8')+'\nend)()\nWire=(function()\n'+fs.readFileSync(new URL('../lua/wire.lua',import.meta.url),'utf8')+'\nend)()');}
 exec(s){const L=this.L;if(lauxlib.luaL_dostring(L,to_luastring(s))!==lua.LUA_OK){const e=to_jsstring(lua.lua_tostring(L,-1));lua.lua_settop(L,0);throw Error(e);}lua.lua_settop(L,0);}
 push(v){const L=this.L;if(v==null)lua.lua_pushnil(L);else if(typeof v==='number')lua.lua_pushnumber(L,v);else if(typeof v==='boolean')lua.lua_pushboolean(L,v);else if(typeof v==='string')lua.lua_pushstring(L,to_luastring(v));else{lua.lua_newtable(L);for(const [k,x]of Object.entries(v)){this.push(Array.isArray(v)?Number(k)+1:k);this.push(x);lua.lua_settable(L,-3);}}}
 read(i){const L=this.L;const t=lua.lua_type(L,i);if(t===lua.LUA_TNIL)return null;if(t===lua.LUA_TBOOLEAN)return lua.lua_toboolean(L,i);if(t===lua.LUA_TNUMBER)return lua.lua_tonumber(L,i);if(t===lua.LUA_TSTRING)return to_jsstring(lua.lua_tostring(L,i));if(t===lua.LUA_TTABLE){i=lua.lua_absindex(L,i);const pairs=[];lua.lua_pushnil(L);while(lua.lua_next(L,i)){pairs.push([this.read(-2),this.read(-1)]);lua.lua_pop(L,1);}if(pairs.every(([k])=>Number.isInteger(k)&&k>0)&&pairs.length===lua.lua_rawlen(L,i)){const a=[];for(const[k,v]of pairs)a[k-1]=v;return a;}return Object.fromEntries(pairs);}throw Error('unsupported Lua result');}
 call(name,...args){const L=this.L;lua.lua_getglobal(L,to_luastring(name));for(const a of args)this.push(a);if(lua.lua_pcall(L,args.length,lua.LUA_MULTRET,0)!==lua.LUA_OK){const e=to_jsstring(lua.lua_tostring(L,-1));lua.lua_settop(L,0);throw Error(e);}const out=[];for(let i=1;i<=lua.lua_gettop(L);i++)out.push(this.read(i));lua.lua_settop(L,0);return out;}
 close(){lua.lua_close(this.L);}
}
export class Authority{
 constructor(n=4,seed=1,mode='quick'){this.vm=new LuaVM();this.vm.exec(`function init(n,seed,mode) S=Core.new(n,seed,mode) end
function view(p) return Core.view(S,p) end
function wire(p) return Wire.encode(Core.view(S,p)) end
function act(p,kind,value,token)
 if kind=='submit' then return Core.submit(S,p,value,token) elseif kind=='choose' then return Core.choose(S,p,value,token) end
 return false,'unknown_action'
end
function advance() return Core.step(S) end
function timeout(token) return Core.timeout(S,token) end
function nextHand() return Core.nextHand(S) end
function bot(p) return Core.bot(Core.view(S,p)) end
function invariant() return Core.assertInvariant(S) end`);this.vm.call('init',n,seed,mode);}
 view(p){return this.vm.call('view',p)[0];} wire(p){return this.vm.call('wire',p)[0];}
 action(p,kind,value,token){return this.vm.call('act',p,kind,value,token);}
 step(){return this.vm.call('advance');} timeout(token){return this.vm.call('timeout',token);}nextHand(){return this.vm.call('nextHand');}bot(p){return this.vm.call('bot',p)[0];}check(){return this.vm.call('invariant')[0];}close(){this.vm.close();}
}
