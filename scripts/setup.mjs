import {spawnSync} from 'node:child_process';import fs from 'node:fs';
const dir='work/simulator',pin='22d75a7398fe68744cc021ab2d8690c76e50ba63';
const run=(cmd,args,cwd='.')=>{const r=spawnSync(cmd,args,{cwd,stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);};
fs.mkdirSync('work',{recursive:true});
if(!fs.existsSync(dir)){
 run('git',['clone','https://github.com/1475505/miliastra-beyond-simulator.git',dir]);run('git',['checkout','--detach',pin],dir);
}else{
 const current=spawnSync('git',['rev-parse','HEAD'],{cwd:dir,encoding:'utf8'}).stdout.trim();
 if(current!==pin)throw Error('已有模拟器版本不同，请保留本地修改并手动核对依赖版本。要求 '+pin);
}
run('npx',['--yes','pnpm@10.15.0','install','--frozen-lockfile','--ignore-scripts'],dir);
run(process.execPath,['scripts/build.mjs','web'],dir);
