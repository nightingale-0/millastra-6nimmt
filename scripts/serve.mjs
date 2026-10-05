import {spawn} from 'node:child_process';
import fs from 'node:fs';
const entry='work/simulator/web/dist/server.js';
if(!fs.existsSync(entry)){console.error('先运行 npm run setup，再运行 npm run build。');process.exit(1);}
const p=spawn(process.execPath,['--import',new URL('./fonts.mjs',import.meta.url).href,entry,'--workspace','outputs','--file','sixnimmt-practice.save.json','--port',process.env.PORT||'4173'],{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>p.kill(signal));
p.on('exit',code=>process.exit(code??0));
