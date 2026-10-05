import {createRequire} from 'node:module';
import fs from 'node:fs';
const require=createRequire(new URL('../work/simulator/package.json',import.meta.url));
const {GlobalFonts}=require('@napi-rs/canvas');
// Headless renderer uses Microsoft YaHei; alias an installed CJK font on macOS.
for(const path of ['/System/Library/Fonts/STHeiti Medium.ttc','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']) {
 if(fs.existsSync(path)){GlobalFonts.registerFromPath(path,'Microsoft YaHei UI');break;}
}
