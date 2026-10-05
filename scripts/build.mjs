import fs from 'node:fs';
import {createStudio} from '../work/simulator/studio/index.js';
import {createNode} from '../work/simulator/studio/ui/authoring.js';
const out='outputs';fs.mkdirSync(out,{recursive:true});
// Warm parchment-on-slate theme: dark slate backdrop, cream paper panels with a
// gold hairline frame, warm dark-brown ink, deep gold accents.
const color={bg:0xff1d4a35,paper:0xfff4ede0,paper2:0xffe8dcc4,line:0xffc8a86a,gold:0xffb8862a,ink:0xff4a3f33,cream:0xfffff8ea,muted:0xff8a7a66,accent2:0xffc9503f,good:0xff4f8a3c,shadow:0x66000000,slot:0x1f4a3f33,band:0xffece2cf};
// Built-in 图片资源库 assets (界面控件组管理 → 素材库 → 图片 → 静态引用 → 引用素材资产).
// `a` is the native width/height ratio, estimated from the picker thumbnails in
// the 2026-09-25 screen recording (thumbnails keep aspect). Images are ALWAYS
// drawn at their own ratio — the first real-machine pass showed non-uniform
// stretching looks bad — so only a height is ever chosen, and the width follows.
// Anything that must stretch (big panels, wide strips) is a flat fill instead.
// If an asset looks wrong on the real machine, swap it here only. The local
// simulator only previews 100001–100006 and shows a "缺少图片" box for the rest.
const ASSET={
 book:{id:107146,a:1.0},     // 底板-彩色: cream notebook page with paw-print corners
 tile:{id:107147,a:1.5},     // 底板-彩色: small cream card — a card laid on the board
 card:{id:107214,a:0.83},    // 底板-彩色: cream arch card — a card in your hand
 glow:{id:106058,a:1.0},     // 底板-单色: soft white glow, tinted gold behind the selected hand card
 btnGold:{id:107233,a:3.2},  // 底板-彩色: gold plaque — primary action
 btnGreen:{id:107151,a:2.7}, // 底板-彩色: green gem bar — start / continue / replay
 btnCream:{id:107240,a:2.9}, // 底板-彩色: cream capsule — secondary action
 btnRed:{id:107084,a:2.6},   // 底板-彩色: red bar — take this row
 round:{id:107203,a:1.0},    // 底板-彩色: cream disc with rim — +/- steppers
 rowTag:{id:107187,a:3.6},   // 底板-彩色: brown strip — row header
 divider:{id:108003,a:12},   // 分隔线: ornamental title underline (tinted gold)
 clock:{id:100143,a:1.0},    // 功能图标-单色: clock face (tinted gold) beside the countdown (105216 read as a monocle)
 bot:{id:103110,a:1.0},      // 玩法图标-彩色: round two-eyed face — the bot count / AI hand-over (105215 read as a camera)
 hourglass:{id:103139,a:0.8},// 玩法图标-彩色: small gold hourglass — a player still choosing
 check:{id:101028,a:1.0},
 checkGreen:{id:101027,a:1.0},// 功能图标-彩色: green tick — a seat that has played    // 功能图标-彩色: yellow tick — a player whose card is in
 help:{id:101050,a:1.0},
 sync:{id:101049,a:1.0},     // 功能图标-彩色: cream disc with circular arrows — "tap to switch" on the mode button
 cards:{id:105046,a:1.0},
 note:{id:101015,a:1.0},
 emote:{id:105142,a:1.0},    // 装饰图案-彩色: round face — the emote button
 chat:{id:100160,a:1.0},
 exitDoor:{id:101039,a:1.0},  // 功能图标-彩色: door with arrow — decoration over the game's own exit button (keep its own colours: no tint)     // 功能图标-单色: speech bubble — decoration over the game's own chat button     // 功能图标-彩色: yellow music note — play / switch music    // 装饰图案-彩色: three cards on a gold disc — marks the hand bar     // 功能图标-彩色: cream disc with "?" — open the rules
 flag:{id:103035,a:1.0},     // 玩法图标-彩色: red flag — settle / vote to settle
 eyeOff:{id:100189,a:1.0},   // 功能图标-单色: crossed-out eye — hide the overlay (tinted)
 plusDisc:{id:101041,a:1.0}, // 功能图标-彩色: cream disc with ＋ (bot count stepper)
 minusDisc:{id:101042,a:1.0},// 功能图标-彩色: cream disc with －
 arrowLeft:{id:101043,a:1.0},// 功能图标-彩色: cream disc with a left arrow — "take this row"
 felt:{id:107136,a:1.88},    // 底板-彩色: green patterned panel — the card table (2026-09-26 picker recording)
 horns:{id:102046,a:1.0},    // 玩法图标-单色: white horned head — the 牛头 penalty marker (tinted)
};
const GOLD_RIM=0xffe0a62e; // selection / current-card rim
const HORNS_TINT=0xffb5483a;
// The whole table UI is a CLIENT control template (client-side resource
// budget); the server control group only holds an empty host container plus
// six/boot, which instantiates the template at runtime. With all ~300 controls
// in the server group, the real editor rejected the level ("服务器端资产使用量
// 过大") once the server node graph was added too (2026-09-26).
const TEMPLATE_ID=1073764407; // NimmtRoot ID the real editor assigned on the latest import (2026-10-01, emotes); it changes on every re-import
// Border mascots (all ids already used elsewhere in the UI): cards, flag, hourglass,
// robot, note, and the emote faces; horns stays the tinted bull head.
const DECO_TINT=0xd9c8a86a;
const DECO_ICONS=[ASSET.horns,ASSET.clock,ASSET.chat,ASSET.flag,ASSET.cards,ASSET.hourglass,ASSET.note,ASSET.bot,ASSET.eyeOff]; // border mascots: one gold tint so they read as monochrome
const root=createNode('container',{id:'game-root',guid:TEMPLATE_ID,name:'NimmtRoot',showCursor:true});
// x/y are the centre in a 1280×720 top-left canvas; as a child, (640,360) is the parent's centre.
function place(n,x,y,w,h){for(const t of [...Object.values(n.transformByPlatform),...Object.values(n.transformByCanvas)]){t.size={x:w,y:h};t.offset={x:x-640,y:360-y};}return n;}
place(root,640,360,1280,720);
function textNode(name,value,size,fg,align='Middle'){return createNode('textbox',{id:name,name,text:value,fontSize:size,minimumFontSize:size,bgColor:0,fontColor:fg,enableOutline:false,horizontalAlignment:align,verticalAlignment:'Top'});}
function rectNode(name,fill){return createNode('textbox',{id:name,name,text:'',fontSize:12,minimumFontSize:12,bgColor:fill,fontColor:0,enableOutline:false,horizontalAlignment:'Middle',verticalAlignment:'Top'});}
function imageNode(name,asset,tint=0xffffffff){return createNode('image',{id:name,name,imageId:asset.id,imageColor:tint});}
const groupNode=name=>createNode('cursor',{id:name,name,raycastTarget:false});
const widthOf=(asset,h)=>Math.round(h*asset.a);
// Text on the real client: GIA can't carry vertical alignment, so text always
// hugs the TOP of its box, and a box shorter than its line height draws nothing
// (the 54px title and the 16px caption vanished in the first real-machine run).
// So boxes are generously tall and positioned by their top edge: the glyphs of
// `lines` lines of `size` px text are centred on cy (constants estimated from the
// recording — glyph top ≈ 0.3×size below the box top, line pitch ≈ 1.3×size).
const GLYPH_TOP=0.3,LINE=1.3;
function textBox(size,cy,lines){const top=cy-GLYPH_TOP*size-(0.9*size+(lines-1)*LINE*size)/2;const h=Math.ceil((GLYPH_TOP+lines*LINE+0.6)*size);return {y:top+h/2,h};}
function label(name,value,cx,cy,w,size=20,fg=color.ink,lines=1,align='Middle'){const b=textBox(size,cy,lines);root.children.push(place(textNode(name,value,size,fg,align),cx,b.y,w,b.h));}
function image(name,asset,cx,cy,h,tint){root.children.push(place(imageNode(name,asset,tint),cx,cy,widthOf(asset,h),h));}
function rect(name,cx,cy,w,h,fill){root.children.push(place(rectNode(name,fill),cx,cy,w,h));}
// Flat paper panel as one named group: gold hairline frame inset 10px, fill, drop shadow.
function panelNode(name,w,h){
 const n=groupNode(name),ins=10,t=2;
 for(const [k,dx,dy,ww,hh] of [['T',0,-(h/2-ins),w-2*ins,t],['B',0,h/2-ins,w-2*ins,t],['L',-(w/2-ins),0,t,h-2*ins],['R',w/2-ins,0,t,h-2*ins]])
  n.children.push(place(rectNode(name+'Line'+k,color.line),640+dx,360+dy,ww,hh));
 n.children.push(place(rectNode(name+'Fill',color.paper),640,360,w,h));
 n.children.push(place(rectNode(name+'Shadow',color.shadow),650,372,w,h));
 return n;
}
// Scoreboard rows with left-aligned columns: rank | name | horn + bull heads.
// cols = {rank,name,horn,score} left edges (x); rows start at y0, pitch dy.
function scoreRows(prefix,y0,dy,size,cols){
 for(let k=1;k<=8;k++){
  const y=y0+(k-1)*dy;
  label(prefix+'Rank'+k,'',cols.rank+40,y,80,size,color.ink,1,'Left');
  label(prefix+'Name'+k,'',cols.name+110,y,220,size,color.ink,1,'Left');
  root.children.push(place(imageNode(prefix+'Horn'+k,ASSET.horns,HORNS_TINT),cols.horn,y,size,size));
  label(prefix+'Score'+k,'',cols.score+35,y,70,size,color.accent2,1,'Left');
 }
}
function panel(name,cx,cy,w,h){root.children.push(place(panelNode(name,w,h),cx,cy,w,h));}
// The notebook page at its native (square) ratio, with a drop shadow, as one named group.
function bookPanel(name,cx,cy,size){
 const n=groupNode(name);
 n.children.push(place(imageNode(name+'Page',ASSET.book),640,360,size,size));
 n.children.push(place(rectNode(name+'Shadow',color.shadow),652,374,size*0.94,size*0.9));
 root.children.push(place(n,cx,cy,size,size));
}
// A label drawn over its own backdrop, a root-level sibling named <name>Skin;
// six/main toggles both together via SKINNED.
const skinned=[];
function filledLabel(name,value,cx,cy,w,h,size,fill,fg=color.ink,lines=1,skinX=cx){label(name,value,cx,cy,w-90,size,fg,lines);rect(name+'Skin',skinX,cy,w,h,fill);skinned.push(name);}
function assetLabel(name,value,cx,cy,h,asset,size,fg,lines=1){label(name,value,cx,cy,widthOf(asset,h),size,fg,lines);image(name+'Skin',asset,cx,cy,h);skinned.push(name);}
function panelLabel(name,value,cx,cy,w,h,size,lines){label(name,value,cx,cy,w-40,size,color.ink,lines);panel(name+'Skin',cx,cy,w,h);skinned.push(name);}
// Buttons are cursors: [text, backdrop…] front-to-back, so the backdrop is the click target.
function buttonText(name,value,w,size,fg,lines,dy=0){const b=textBox(size,360+dy,lines);return place(textNode(name+'Text',value,size,fg),640,b.y,w,b.h);}
// A card face's content: big number on top, horned-head icon + "×N" underneath.
// Returned nodes are positioned relative to (cx,cy) in the same frame as `place`.
function cardParts(name,cx,cy,numSize,iconSize,headsSize,numDy,rowDy){
 const num=textBox(numSize,cy+numDy,1),heads=textBox(headsSize,cy+rowDy,1);
 return [
  place(textNode(name,'',numSize,color.ink),cx,num.y,90,num.h),
  place(imageNode(name+'Icon',ASSET.horns,HORNS_TINT),cx-iconSize*0.55,cy+rowDy,iconSize,iconSize),
  place(textNode(name+'Heads','',headsSize,color.accent2),cx+iconSize*0.6,heads.y,40,heads.h),
 ];
}
function button(name,value,cx,cy,asset,h,fg=color.ink,size=19,lines=1){
 const w=widthOf(asset,h),n=place(createNode('cursor',{id:name,name}),cx,cy,w,h);
 n.children.push(buttonText(name,value,w,size,fg,lines));
 n.children.push(place(imageNode(name+'Skin',asset),640,360,w,h));
 root.children.push(n);return n;
}
// Icon + label as one centred group, 4px apart. chars = label length used for
// centring (runtime labels such as "结算 1/2" grow to the right from there).
function iconButton(name,value,cx,cy,w,h,fill,icon,iconH,fg=color.ink,size=13,tint,chars=[...value].length){
 const n=place(createNode('cursor',{id:name,name}),cx,cy,w,h);
 const iw=widthOf(icon,iconH),tw=chars*size,gx=640-(iw+4+tw)/2;
 n.children.push(place(imageNode(name+'Icon',icon,tint),gx+iw/2,360,iw,iconH));
 const tb=textBox(size,360,1);n.children.push(place(textNode(name+'Text',value,size,fg),gx+iw+4+tw/2,tb.y,Math.max(tw+8,w-iw-12),tb.h));
 n.children.push(place(rectNode(name+'Fill',fill),640,360,w,h));
 n.children.push(place(rectNode(name+'Edge',color.line),640,360,w+4,h+4));
 root.children.push(n);return n;
}
function flatButton(name,value,cx,cy,w,h,fill,fg=color.ink,size=19){
 const n=place(createNode('cursor',{id:name,name}),cx,cy,w,h);
 n.children.push(buttonText(name,value,w,size,fg,1));
 n.children.push(place(rectNode(name+'Fill',fill),640,360,w,h));
 n.children.push(place(rectNode(name+'Edge',color.line),640,360,w+4,h+4));
 root.children.push(n);return n;
}
// Authoring child order is front-to-back: add interactive content first, its
// backdrop panel right after (so clicks reach the buttons, not the panel),
// and the full-canvas Background last of all, behind every scene.

// --- Rules pop-up: authored first so it sits in front of every scene ---
// Illustrated rules, 4 pages (text + a row of example cards; set by six/main).
// Front-to-back: buttons, example cards (number, heads, face, rim), texts, panel.
button('RulesPrev','上一页',470,600,ASSET.btnCream,48,color.ink,16);
button('RulesClose','知道了',640,600,ASSET.btnGreen,52,color.cream,18);
button('RulesNext','下一页',810,600,ASSET.btnCream,48,color.ink,16);
// Rows diagram (page 2): row r at y, cards overlap by 9 px; your card on the right.
for(let r=1;r<=4;r++){
 const y=290+(r-1)*50;
 for(let j=1;j<=5;j++){
  const x=440+(j-1)*31;
  label('RuleRow'+r+'_'+j,'',x,y-9,30,14,color.ink);
  image('RuleRowFace'+r+'_'+j,ASSET.card,x,y,44);
 }
 image('RuleRowRim'+r,ASSET.card,440,y,52,GOLD_RIM);               // moved onto the target row's last card
}
label('RuleMineLabel','你的牌',820,300,120,14,color.muted);
label('RuleMine','',820,352,70,26,color.ink);
image('RuleMineFace',ASSET.card,820,364,84);
image('RuleMineRim',ASSET.card,820,364,96,GOLD_RIM);
for(let i=1;i<=7;i++){
 const x=640+(i-4)*86,y=352;
 label('RuleCard'+i,'',x,y-12,70,26,color.ink);
 root.children.push(place(imageNode('RuleHorn'+i,ASSET.horns,HORNS_TINT),x-12,y+24,14,14));
 label('RuleHeads'+i,'',x+10,y+24,30,14,color.accent2);
 image('RuleFace'+i,ASSET.card,x,y,84);
 image('RuleRim'+i,ASSET.card,x,y,96,GOLD_RIM);
}
label('RulesTitle','',640,152,700,24,color.gold);
label('RulesPage','',640,184,200,13,color.muted);
label('RulesText','',640,236,700,17,color.ink,2);
label('RulesNote','',640,498,700,16,color.muted,3);
panel('RulesBoardSkin',640,360,800,568);

// --- Launch scene (inside a 680×680 notebook page, y 20–700) ---
label('LaunchTitle','Take 6!',640,222,560,54,color.gold);
image('LaunchAccent',ASSET.divider,640,284,28,color.gold);
label('LaunchSubtitle','同时出牌，从小到大落位；牛头分最少者获胜',640,326,560,18,color.muted);
button('LaunchStart','开    始',640,440,ASSET.btnGold,76,color.ink,24);
button('LaunchRules','游戏规则',640,528,ASSET.btnCream,52,color.ink,17);
bookPanel('LaunchPanel',640,360,680);

// --- Setup scene: bot count/mode/ready (practice is always exactly you + bots) ---
label('SetupTitle','Take 6!',640,110,560,30,color.gold);
image('SetupAccent',ASSET.divider,640,146,24,color.gold);
label('BotsCaption','机器人数量',640,188,400,16,color.muted);
button('BotsMinus','',530,240,ASSET.minusDisc,56);
image('BotIcon',ASSET.bot,618,240,48);
label('BotsCount','',672,240,70,28);
button('BotsPlus','',750,240,ASSET.plusDisc,56);
image('ModeSync',ASSET.sync,640+200-30,318,28);            // "tap to switch" mark
flatButton('ModeStep','',640,318,400,50,color.paper2,color.accent2,18);
flatButton('ReadyToggle','',640,388,400,56,color.accent2,color.cream,20);
label('SetupHint','全员准备后自动开局',640,440,560,13,color.muted);
button('SetupBegin','准备',525,530,ASSET.btnGreen,80,color.cream,19);
button('SetupRules','游戏规则',765,530,ASSET.btnCream,70,color.ink,19);
bookPanel('SetupPanel',640,360,680);

// --- Corner toggle: double-click to hide the whole overlay so chat/other game keys work ---
// UiToggle is authored after the board so it can use the icon-column tile (bottom = hand bar bottom).

// --- Board scene ---
// Layout D (2026-09-27). Content box = gold frame inset 23px: x 48–1232, y 43–677.
//   columns  icons 48–96 | main 116–876 | right 896–1232   (20px gutters)
//   rows     lane 43–129 | felt 145–549 | hand 565–677     (16px gutters)
// Every block edge lines up with a neighbour: icon tiles top = lane top, bottom
// tiles = hand bar edges, ranking spans exactly the felt, confirm top = hand top.
// Felt interior: 24px padding on all four sides, rows 12px apart; each row is
// [penalty ribbon | 5 slots | "收走" button (only while you choose a row)].
const XI=72,XM=496,XR=1064,MAIN={x:116,w:760},RIGHT={x:896,w:336};
const LANE={x:116,y:43,w:760,h:86},HAND={x:116,y:565,w:760,h:112};
const FELT_H=404,FELT_W=widthOf(ASSET.felt,FELT_H),TABLE={x:XM-FELT_W/2,y:145,w:FELT_W,h:FELT_H};
const PAD=24,SLOT_H=80,ROW_GAP=12,CARD_H=68,SLOT_W=widthOf(ASSET.card,SLOT_H);
const RIB_H=32,RIB_W=widthOf(ASSET.rowTag,RIB_H),BTN_H=36,BTN_W=widthOf(ASSET.btnRed,BTN_H);
const INNER={x:TABLE.x+PAD,w:TABLE.w-2*PAD};
const COL_GAP=(INNER.w-RIB_W-PAD-5*SLOT_W-PAD-BTN_W)/4; // slots share what's left
const RIB_X=INNER.x+RIB_W/2,SLOT_X0=INNER.x+RIB_W+PAD+SLOT_W/2,BTN_X=INNER.x+INNER.w-BTN_W/2;
const rowY=r=>TABLE.y+PAD+SLOT_H/2+(r-1)*(SLOT_H+ROW_GAP);
function band(name,box,fill=color.band){
 const n=groupNode(name);
 n.children.push(place(rectNode(name+'Fill',fill),640,360,box.w,box.h));
 n.children.push(place(rectNode(name+'Edge',color.line),640,360,box.w+4,box.h+4));
 root.children.push(place(n,box.x+box.w/2,box.y+box.h/2,box.w+4,box.h+4));
}
// 48×48 icon tile: icon on top, a 2-character caption under it.
function tile(name,caption,cy,icon,iconH,tint,fg=color.ink){
 const n=place(createNode('cursor',{id:name,name}),XI,cy,48,48);
 n.children.push(place(imageNode(name+'Icon',icon,tint),640,352,widthOf(icon,iconH),iconH));
 const tb=textBox(11,373,1);n.children.push(place(textNode(name+'Text',caption,11,fg),640,tb.y,48,tb.h));
 n.children.push(place(rectNode(name+'Fill',color.paper2),640,360,48,48));
 n.children.push(place(rectNode(name+'Edge',color.line),640,360,52,52));
 root.children.push(n);return n;
}
// Hand-end overlay first so it sits in front of the rows it covers.
button('Next','继续下一手',XM,TABLE.y+FELT_H-30,ASSET.btnGreen,56,color.cream,18);
scoreRows('HandEnd',TABLE.y+100,28,18,{rank:256,name:336,horn:560,score:576});
label('HandEndBoard','',XM,TABLE.y+64,520,18);
panel('HandEndBoardSkin',XM,TABLE.y+FELT_H/2-20,560,320); skinned.push('HandEndBoard');
// icon column
// The top-left corner stays free for the game's own exit button (centre 38,30): the
// tiles start level with the felt's top edge.
tile('HandOver','托管',TABLE.y+24,ASSET.bot,24);   // 托管 / 接管: the AI plays your seat
tile('RulesButton','规则',TABLE.y+80,ASSET.help,22);
tile('MusicButton','音乐',TABLE.y+136,ASSET.note,22);           // play / next track / off
tile('MuteButton','静音',TABLE.y+192,ASSET.note,22,color.muted,color.muted); // music on / off (音乐 only switches tracks)
// Emote picker: front-to-back = 8 choices, then the panel behind them.
const EMOTES=[105021,105022,105023,105143,105144,103101,103102,105164];
for(let k=1;k<=8;k++){
 const x=XI+64+((k-1)%4)*56,y=TABLE.y+304-28+Math.floor((k-1)/4)*56;
 const n=place(createNode('cursor',{id:'Emote'+k,name:'Emote'+k}),x,y,48,48);
 n.children.push(place(imageNode('Emote'+k+'Img',{id:EMOTES[k-1],a:1}),640,360,40,40));
 n.children.push(place(rectNode('Emote'+k+'Fill',color.paper),640,360,48,48));
 root.children.push(n);
}
rect('EmotePanelFill',XI+64+84,TABLE.y+304,240,128,color.paper2);
rect('EmotePanelEdge',XI+64+84,TABLE.y+304,244,132,color.line);
tile('EmoteButton','表情',TABLE.y+304,ASSET.emote,24);
tile('UiToggle','隐藏',TABLE.y+248,ASSET.eyeOff,22,color.muted,color.muted); // double-click: hide / show the whole overlay
// The game's own exit / chat buttons are left uncovered (fake overlays drifted off
// them on 16:10 and 21:9 screens). Plain text boxes / images let clicks through; a
// CURSOR node (光标检测区) does not - so nothing large may be a cursor group.
// Decoration over the game's own exit (38,30) and chat (39,693) buttons.
image('ExitDecoIcon',ASSET.exitDoor,38,30,20);
rect('ExitDecoFill',38,30,30,30,color.paper2);
rect('ExitDecoEdge',38,30,34,34,color.line);
image('ChatDecoIcon',ASSET.chat,39,693,16,color.ink);
rect('ChatDecoFill',39,693,30,26,color.paper2);
rect('ChatDecoEdge',39,693,34,30,color.line);
image('HandLogo',ASSET.cards,XI,HAND.y+26,40);                   // marks the hand bar (vs the table)
label('HandLogoText','手牌',XI,HAND.y+56,48,12,color.muted);
// right column, top: mode / round / status (same height as the lane)
label('ModeNote','',XR,LANE.y+10,RIGHT.w,13,color.muted);
label('Config','',XR,LANE.y+32,RIGHT.w,16);
label('Status','',XR,LANE.y+66,RIGHT.w,17);
// right column: ranking boxes spanning exactly the felt's height
for(let p=1;p<=8;p++){
 const y=Math.round(TABLE.y+19+(p-1)*(FELT_H-38)/7);
 const RW=Math.round(RIGHT.w*0.8),RX=XR-RW/2;                      // 80% width, centred on the confirm button
 // [name, left-aligned, room for 12 bytes (6 CJK chars)] [+X flash] [horn] [score]
 // right edge mirrors the name's 16px left inset for a two-digit score
 label('Player'+p+'Gain','',RX+RW-76,y,40,15,color.accent2);           // +X for 5 s after taking bull heads
 root.children.push(place(imageNode('Player'+p+'Horn',ASSET.horns,HORNS_TINT),RX+RW-46,y,16,16));
 label('Player'+p+'Score','',RX+RW-19,y,38,16,color.accent2);         // wider: 2-3 digit counts
 image('Player'+p+'Bot',ASSET.bot,RX+RW-106,y,18);                   // 托管 marker (instead of "(托管)" in the name)
 label('Player'+p,'',RX+16+72,y,144,15,color.ink,1,'Left');
 // Emote chat bubble just left of the row: image, then bubble fill, edge, tail (front to back).
 image('Player'+p+'Emote',{id:EMOTES[0],a:1},RX-22,y,30);                 // image set at runtime
 rect('Player'+p+'EmoteBg',RX-22,y,40,36,color.cream);
 rect('Player'+p+'EmoteTail',RX-1,y,8,8,color.cream);                       // tail pointing at the ranking box
 rect('Player'+p+'EmoteEdge',RX-22,y,44,40,color.line);
 rect('Player'+p+'EmoteTailEdge',RX-0,y,12,12,color.line);
 rect('Player'+p+'Skin',XR,y,RW,38,color.paper2); skinned.push('Player'+p);
}
// the reveal lane ("待定区"): 8 mini cards, 64px apart, centred in the lane panel.
// select: one face-down back per seat that has played; reveal: the sorted
// queue face up, the one being placed ringed by a gold glow, placed ones fly
// to their slot and disappear.
const MINI_H=58,MINI_PITCH=92; // 92: room for a 6-character name (11 px) under each card
for(let k=1;k<=8;k++){
 const x=XM+(k-4.5)*MINI_PITCH,y=LANE.y+36;
 image('Lane'+k+'Check',ASSET.checkGreen,x+18,y-22,18);              // played (select phase)
 label('Lane'+k,'',x,y-4,48,20);                                    // card number
 image('Lane'+k+'Face',ASSET.card,x,y,MINI_H);
 image('Lane'+k+'Glow',ASSET.card,x,y,MINI_H+10,GOLD_RIM);          // highlight: a gold card-shaped rim behind the card being placed
 label('Lane'+k+'Name','',x,LANE.y+LANE.h-10,MINI_PITCH-2,11,color.muted);
}
band('LanePanel',LANE,color.paper2);
// table
for(let r=1;r<=4;r++){
 const y=rowY(r);
 root.children.push(place(imageNode('RowIcon'+r,ASSET.horns,0xfffff8ea),RIB_X-19,y,16,16));
 assetLabel('RowLabel'+r,'',RIB_X,y,RIB_H,ASSET.rowTag,15,color.cream);
 for(let j=1;j<=5;j++){
  const x=Math.round(SLOT_X0+(j-1)*(SLOT_W+COL_GAP)),cell=`Board${r}_${j}`;
  root.children.push(...cardParts(cell,x,y,22,14,12,-9,16));
  image(cell+'Face',ASSET.card,x,y,CARD_H);
  image(cell+'Slot',ASSET.card,x,y,SLOT_H,0x4dfff8ea); // chalk outline on the felt
 }
 button('RowAction'+r,'收走',BTN_X,y,ASSET.btnRed,BTN_H,color.cream,15); // shown only while you choose a row
}
image('TablePanel',ASSET.felt,XM,TABLE.y+FELT_H/2,FELT_H,0xd9ffffff); // 85% opaque
// hand bar
for(let i=1;i<=10;i++){
 const name='Hand'+i,w=widthOf(ASSET.card,84),step=(HAND.w-10*w)/11;
 const n=place(createNode('cursor',{id:name,name}),Math.round(HAND.x+step+w/2+(i-1)*(w+step)),HAND.y+HAND.h/2,w,84);
 // cursor → [number, icon, ×N, card face, selection glow] front-to-back; the
 // glow sits behind the face, a little larger so it shows as a halo.
 n.children.push(...cardParts(name+'Text',640,360,26,17,14,-12,20));
 n.children.push(place(imageNode(name+'Skin',ASSET.card),640,360,w,84));
 n.children.push(place(imageNode(name+'Glow',ASSET.card,GOLD_RIM),640,360,widthOf(ASSET.card,96),96)); // gold card-shaped rim (the soft glow asset drew as a solid square in-game)
 root.children.push(n);
}
band('HandBand',HAND);
// right column, bottom: confirm (top = hand top) and the countdown
button('Confirm','确认出牌',XR,HAND.y+26,ASSET.btnGold,52,color.ink,18);
image('TimerIcon',ASSET.clock,XR-38,HAND.y+82,22,color.gold);
label('Timer','',XR+10,HAND.y+82,120,20,color.gold);
label('Log','',XM,700,10,1,color.muted,1); // kept for the practice script; parked off-view
{
 const L=15,T=10,R=1265,B=710,ins=10,t=2;
 const add=(name,fill,x0,y0,x1,y1)=>rect(name,(x0+x1)/2,(y0+y1)/2,x1-x0,y1-y0,fill);
 for(const [i,x,y] of [[1,L+5,T+5],[2,R-5,T+5],[3,L+5,B-5],[4,R-5,B-5]])rect('BoardRivet'+i,x,y,6,6,color.line);
 for(let i=1;i<=20;i++){ // gold bull-head studs along the top / bottom gutters
  const x=130+(i-1)*58;
  // a different mascot per stud; six/main tilts each one (GIA cannot store rotation)
  const pick=k=>DECO_ICONS[(k*5+3)%DECO_ICONS.length];
  if(Math.abs(x-640)>90)image('BoardDecoT'+i,pick(i),x,32,18,DECO_TINT);
  image('BoardDecoB'+i,pick(i+20),x,694,18,DECO_TINT);
 }
 assetLabel('TitleTab','Take 6',640,24,26,ASSET.rowTag,14,color.cream);
 add('BoardPanelLineT',color.line,L+ins,T+ins,R-ins,T+ins+t);
 add('BoardPanelLineB',color.line,L+ins,B-ins-t,R-ins,B-ins);
 add('BoardPanelLineL',color.line,L+ins,T+ins,L+ins+t,B-ins);
 add('BoardPanelLineR',color.line,R-ins-t,T+ins,R-ins,B-ins);
 add('BoardPanelInner',color.paper,L+ins,T+ins,R-ins,B-ins);
 add('BoardPanelFill',0xff7a5230,L,T,R,B);               // wood rim
 add('BoardPanelShadow',color.shadow,L+10,T+12,R+10,B+12);
}

// --- Game over / settlement scene ---
label('ResultTitle','对局结束',640,112,560,34,color.gold);
label('ResultReason','',640,166,560,17,color.muted);
// one line per player, 44px apart: 第N名  name  score
scoreRows('Result',226,44,24,{rank:418,name:516,horn:782,score:802});
// 再来一局 (back to the setup page) | 投票结算 x/y (network: a majority settles the level)
// One button; the line under it explains the 30 s vote.
button('ReplayButton','再来一局',640,590,ASSET.btnGreen,72,color.cream);
label('ResultVote','',640,652,600,13,color.muted,2);
bookPanel('ResultPanel',640,360,680);

// 3x the design canvas: the root is scaled to FIT (letterbox), so on 16:10 or
// 21:9 screens the background must reach past the 1280x720 box to hide the world.
rect('Background',640,360,3840,2160,color.bg);
const host=place(createNode('container',{id:'nimmt-host',name:'NimmtHost',showCursor:true}),640,360,1280,720);
const serverProject={version:3,meta:{name:'Take 6! · 6 nimmt!',assetType:'server-control-template'},canvasId:'mobile-16-9',root:createNode('server-container',{id:'server-root',name:'SixNimmtUI',children:[host]}),selectedId:'nimmt-host'};
const clientProject={version:1,meta:{name:'Take 6! 界面',assetType:'client-control-template',sourceFormat:'authoring',sourceFile:'',gameVersion:'7.0.50',giaOwnerUid:114514,giaFileId:1073741829,giaFileName:'客户端控件模板列表.gia'},canvasId:'mobile-16-9',root:createNode('server-container',{id:'client-root',name:'客户端控件模板',children:[root]}),selectedId:'game-root'};
const saveSeed={format:'qxqy-simulator-save',version:3,meta:{name:'Take 6!'},activeAssetType:'server-control-template',serverLogic:{rules:[]},assets:{server:serverProject,client:clientProject}};
// six/boot: the only script on the server control group. The template index
// defaults to TEMPLATE_ID; if the editor assigns a different ID on import, set
// the script parameter templateId on NimmtHost instead of rebuilding.
const bootSource=`local TEMPLATE_IDS={${TEMPLATE_ID}}
function OnStart()
  local ok,p=pcall(function() return script:GetParam('templateId') end)
  if ok and type(p)=='number' and p>0 then table.insert(TEMPLATE_IDS,1,p) end
  -- The editor may re-assign the template ID on import: try each candidate.
  local ui,id
  for _,candidate in ipairs(TEMPLATE_IDS) do
    id=candidate; ui=game.InstantiateClientUIControl(id,script.object)
    print('[nimmt] try template',id,ui~=nil)
    if ui then break end
  end
  print('[nimmt] instantiate template',id,ui~=nil)
end
`;
// The official client Lua sandbox has no `require` global (confirmed against the
// published client-script API reference, which lists every global function and
// omits it). six/main must not depend on cross-script `require('six/core')` calls
// resolving at runtime, so it carries its own tiny module table + local `require`
// shim and inlines core.lua unmodified inside it. wire.lua is no longer required by
// client.lua (NimmtSnapshot now arrives as typed signal params, not an encoded
// string — see docs/server-contract.md) but is still exported as six/wire for
// reference. six/core is still exported standalone too, but six/main no longer
// depends on either being wired up correctly to run.
// Authored layer order (front-to-back) for every parent with 2+ children,
// emitted as LAYERS for six/main to apply at runtime with SetAsFirstSibling.
// After moving the UI into an instantiated client template, the real client
// drew the full-screen Background over everything (2026-09-26): the stacking
// direction there is not the one the export assumed, so six/main now sets it
// explicitly instead of trusting the exported child order.
function layerGroups(node,path,out){
 const kids=node.children||[];
 if(kids.length>1)out.push([path,kids.map(c=>c.name)]);
 for(const c of kids)layerGroups(c,path===''?c.name:path+'/'+c.name,out);
 return out;
}
const layerTable='local LAYERS = {'+layerGroups(root,'',[]).map(([p,names])=>'{'+JSON.stringify(p)+',{'+names.map(n=>JSON.stringify(n)).join(',')+'}}').join(',')+'}\n';
function bundleModules(mods){
 let s='local __modules={}\nlocal function require(path) return __modules[path] end\n';
 for(const [name,file] of mods)s+=`__modules['${name}']=(function()\n`+fs.readFileSync(file,'utf8')+'\nend)()\n';
 return s;
}
const reports={};
for(const mode of ['practice','network']){
 const studio=createStudio(structuredClone(saveSeed));
 // Only six/main is exported: it already bundles core.lua, and every extra
 // script is duplicated again on each re-import (the level's resource budget
 // filled up with core_1..6 / wire_1..6 copies on 2026-09-26).
 const skinTable='local SKINNED = {'+skinned.map(n=>n+'=true').join(',')+'}\n'+layerTable;
 const mainSource=`local MODE = '${mode}'\n`+skinTable+bundleModules([['six/core','lua/core.lua']])+fs.readFileSync('lua/client.lua','utf8');
 studio.patch({op:'addScript',controlId:'game-root',controlAsset:'client-control-template',path:'six/main',source:mainSource});
 studio.patch({op:'addScript',controlId:'nimmt-host',controlAsset:'server-control-template',path:'six/boot',source:bootSource});
 studio.patch({op:'renameSave',name:'Take 6! · '+(mode==='practice'?'人机练习':'多人客户端')});
 const save=studio.exportData('save');fs.writeFileSync(`${out}/sixnimmt-${mode}.save.json`,Buffer.from(save.data,'base64'));
 const scripts=studio.exportData('scripts');fs.writeFileSync(`${out}/sixnimmt-${mode}.scripts.json`,Buffer.from(scripts.data,'base64'));
 try {const gia=studio.exportData('gia-combined');fs.writeFileSync(`${out}/sixnimmt-${mode}.gia`,Buffer.from(gia.data,'base64'));reports[mode]=Object.fromEntries(Object.entries(gia).filter(([k])=>k!=='data'));}catch(e){reports[mode]={error:e.message};}
}
// The editor's import dialog lists BeyondLocal/Beyond_Local_Export: keep the
// network build there too, or imports silently pick up a stale copy (every
// import from 2026-09-26 13:00 to 2026-09-27 10:00 loaded the 12:50 build).
const exportDir=process.env.LOCALAPPDATA?process.env.LOCALAPPDATA.replace(/Local$/,'LocalLow')+'/miHoYo/原神/BeyondLocal/Beyond_Local_Export':null;
if(exportDir&&fs.existsSync(exportDir)){fs.copyFileSync(`${out}/sixnimmt-network.gia`,exportDir+'/sixnimmt-network.gia');console.log('Copied sixnimmt-network.gia to',exportDir);}
fs.writeFileSync(`${out}/export-report.json`,JSON.stringify(reports,null,2));console.log('Built practice/network saves, script bundles and GIA export report.');
