-- MODE and SKINNED are prepended by the build.
-- practice: this client runs the rules locally (six/core). That state lives only
--   in this client's memory, so a reconnect restarts it — nothing on the client
--   can persist (the client API has no storage; see docs/server-contract.md).
-- network: the server node graph is the authority. It publishes the table as
--   custom variables — public state on the Level entity, your private hand on
--   your own player entity — and this client only reads them and sends intents
--   (NimmtStart/Submit/ChooseRow/Vote/Sync). Server-side state is what survives
--   a reconnect: OnStart re-reads the variables and the board comes back.
local Core=require('six/core')
local root,state,view,selected,elapsed,deadline,lastPhase
local scene='launch' -- 'launch'|'setup'|'board'|'gameover'
-- Practice is always exactly you (seat 1) plus bots; in network mode the server
-- seats every human on the field and fills the rest with this many bots.
local bots,mode,seed=0,'quick',20260924 -- 0 bots by default (fixBots raises it to 1 when alone)
local readySentAt=-100 -- os.clock() of our last ready request (the server's flag may lag behind it)
local function lobbyLoaded() -- everyone the match expects has entered the level
  if MODE=='practice' then return true end
  return view~=nil and view.phase=='lobby' and view.seat>0 and view.n>=1 and (view.expected or 0)<=view.n
end
local ready=false -- lobby "ready" gate on the Setup screen; resets whenever bots/mode change.
local COUNTDOWN_SECONDS=3
local countdown -- nil, or seconds left before an auto-start once everyone (you) is ready.
local selfControlled=true -- practice: false once you hand seat 1 over to the AI (mid-match "exit").
local clock=0 -- seconds since start (OnUpdate)
local lastScores,gains={},{} -- per seat: last score seen / {amount,untilT} of the latest gain
-- Sound effects (editor audio library IDs), one picked at random each time.
local SFX_BULL={40115,40241,20102,10067}   -- someone takes bull heads: slap / thunder blast / beast grunt / jump scare
local SFX_EMOTE={50910,50394,50526,51045}  -- emotes: click / magic feedback / magic appear / light tap
-- Emotes: the same 8 images as the picker (build.mjs EMOTES).
local EMOTE_IMG={105021,105022,105023,105143,105144,103101,103102,105164}
local EMOTE_PARTS={'EmotePanelFill','EmotePanelEdge'}
for k=1,8 do EMOTE_PARTS[#EMOTE_PARTS+1]='Emote'..k end
local emotePanelOpen=false
local lastEmoteSent=-100          -- clock of our last emote (2 s cooldown)
local seenEmote={}                -- per seat: last emote code seen (seq*10+emote)
local emoteShow={}                -- per seat: {img, untilT}
local function playRandom(list)
  local id=list[math.random(#list)]
  local ok,err=pcall(function() game.PlayAudio2D(id) end)
  if not ok then print('[nimmt] sfx failed',id,err) end
end
-- The fake exit tile only appears once the game's own exit button does (30 s in).
local levelTime,exitShown=0,false
local EXIT_PARTS={'ExitDecoIcon','ExitDecoFill','ExitDecoEdge'}
-- Modes and their wire numbers / labels.
local MODE_NUM={quick=0,standard=1,short=2}
local MODE_OF={[0]='quick','standard','short'}
local MODE_NAME={quick='单局',short='33分',standard='66分'}
local MODE_NEXT={quick='short',short='standard',standard='quick'} -- 单局 → 33分 → 66分
local uiHidden=false -- toggled by double-clicking UiToggle; hides the whole overlay for chat/other game keys.
local lastUiToggleClickAt=-1000 -- far in the past so the very first click is never mistaken for a double-click
local DOUBLE_CLICK_WINDOW=0.6 -- generous, to tolerate real click/input latency the sandbox simulator doesn't have
-- network: the server republishes secondsLeft only every ~3 s (a publish takes
-- several ticks), so the client counts down locally every frame (OnUpdate) and
-- re-syncs on each publish (onVars).
local timerLeft,timerShown,timerKey=0,-1,nil
local function timerText(s) return string.format('%02d:%02d',math.floor(s/60),s%60) end
-- network: optimistic feedback while the server catches up (a publish takes a
-- few ticks): "starting" after NimmtStart, and the card / row we just sent.
local starting=false
local sentCard,sentRow,sentToken
local playedCard,playedToken -- your card this round, kept after the server confirms it
local BOARD_DECOR={'BoardRivet1','BoardRivet2','BoardRivet3','BoardRivet4'}
for i=1,20 do BOARD_DECOR[#BOARD_DECOR+1]='BoardDecoT'..i; BOARD_DECOR[#BOARD_DECOR+1]='BoardDecoB'..i end
local BOARD_WIDGETS={'ModeNote','Config','Status','Timer','TimerIcon','RulesButton','MusicButton','MuteButton','EmoteButton','HandOver','Log','Confirm','HandEndBoard','Next',
  'HandEndRank1','HandEndRank2','HandEndRank3','HandEndRank4','HandEndRank5','HandEndRank6','HandEndRank7','HandEndRank8',
  'HandEndName1','HandEndName2','HandEndName3','HandEndName4','HandEndName5','HandEndName6','HandEndName7','HandEndName8',
  'HandEndHorn1','HandEndHorn2','HandEndHorn3','HandEndHorn4','HandEndHorn5','HandEndHorn6','HandEndHorn7','HandEndHorn8',
  'HandEndScore1','HandEndScore2','HandEndScore3','HandEndScore4','HandEndScore5','HandEndScore6','HandEndScore7','HandEndScore8','BoardPanelLineT','BoardPanelLineB','BoardPanelLineL','BoardPanelLineR','BoardPanelFill','BoardPanelInner','BoardPanelShadow','TitleTab','HandBand','TablePanel','LanePanel','HandLogo','HandLogoText'}
for k=1,8 do for _,s in ipairs({'','Face','Glow','Name','Check','Bot'}) do BOARD_WIDGETS[#BOARD_WIDGETS+1]='Lane'..k..s end end
for r=1,4 do
  BOARD_WIDGETS[#BOARD_WIDGETS+1]='RowLabel'..r; BOARD_WIDGETS[#BOARD_WIDGETS+1]='RowIcon'..r; BOARD_WIDGETS[#BOARD_WIDGETS+1]='RowAction'..r
  for j=1,5 do
    local cell='Board'..r..'_'..j
    for _,part in ipairs({'','Icon','Heads','Slot','Face'}) do BOARD_WIDGETS[#BOARD_WIDGETS+1]=cell..part end
  end
end
for p=1,8 do for _,s in ipairs({'','Score','Horn','Gain','Bot','Emote','EmoteBg','EmoteTail','EmoteEdge','EmoteTailEdge'}) do BOARD_WIDGETS[#BOARD_WIDGETS+1]='Player'..p..s end end
for i=1,10 do BOARD_WIDGETS[#BOARD_WIDGETS+1]='Hand'..i end
for _,n in ipairs(BOARD_DECOR) do BOARD_WIDGETS[#BOARD_WIDGETS+1]=n end
local LAUNCH_WIDGETS={'LaunchTitle','LaunchAccent','LaunchSubtitle','LaunchStart','LaunchRules','LaunchPanel'}
local SETUP_WIDGETS={'SetupTitle','SetupAccent','BotsCaption','BotsMinus','BotIcon','BotsCount','BotsPlus','ModeStep','ModeSync','ReadyToggle','SetupHint','SetupBegin','SetupRules','SetupPanel'}
local RESULT_WIDGETS={'ResultTitle','ResultReason','ReplayButton','ResultVote','ResultPanel'}
for k=1,8 do for _,s in ipairs({'Rank','Name','Horn','Score'}) do RESULT_WIDGETS[#RESULT_WIDGETS+1]='Result'..s..k end end
local RULE_WIDGETS={'RulesBoardSkin','RulesTitle','RulesPage','RulesText','RulesNote','RulesPrev','RulesNext','RulesClose'}
for i=1,7 do for _,s in ipairs({'RuleCard','RuleHorn','RuleHeads','RuleFace','RuleRim'}) do RULE_WIDGETS[#RULE_WIDGETS+1]=s..i end end
for r=1,4 do RULE_WIDGETS[#RULE_WIDGETS+1]='RuleRowRim'..r; for j=1,5 do RULE_WIDGETS[#RULE_WIDGETS+1]='RuleRow'..r..'_'..j; RULE_WIDGETS[#RULE_WIDGETS+1]='RuleRowFace'..r..'_'..j end end
for _,n in ipairs({'RuleMineLabel','RuleMine','RuleMineFace','RuleMineRim'}) do RULE_WIDGETS[#RULE_WIDGETS+1]=n end
local ALL_WIDGETS={'Background','ChatDecoIcon','ChatDecoFill','ChatDecoEdge'}
for _,n in ipairs(RULE_WIDGETS) do ALL_WIDGETS[#ALL_WIDGETS+1]=n end
-- Rules pages: title, body, example cards {number, 'play' = ringed / 'take' = greyed}, note.
local RULE_PAGES={
  {t='同时亮牌，从小到大结算',b='所有人同时出一张牌，一起翻开。\n然后从最小的那张开始，一张一张地放到桌上。',
   cards={{7,'play'},{30},{52}},n='比如三个人分别出了 30、7、52，\n先放 7，再放 30，最后放 52。'},
  {t='放在刚好比它小的那一行末尾',b='每张牌都放到某一行的末尾。\n选哪一行，就看每行最后一张：找比你的牌小、又最接近的那一张。',
   rows={{3,7,12},{14,19,22,25},{33,40},{51,60,72,85,88}},target=2,mine=30,cards={},n='四行的最后一张分别是 12、25、40、88，比 30 小的是 12 和 25。\n25 离 30 最近，所以 30 放在 25 那一行的末尾，就是金框那张后面。'},
  {t='放成第六张，就收走这一行',b='每行最多放五张。',
   cards={{3,'take'},{8,'take'},{14,'take'},{20,'take'},{27,'take'},{31,'play'}},n='如果你的牌要放成这一行的第六张，\n前面五张就归你，它们的牛头都算你的，你的牌成为这一行新的第一张。'},
  {t='比所有行尾都小，就自己选一行收走',b='如果你的牌比四行的最后一张都小，它放不进任何一行。',
   cards={{2,'play'},{15},{40},{62},{88}},n='比如你出了 2，而四行的最后一张是 15、40、62、88，\n你就要自己挑一行收走，最好挑牛头最少的那行，2 成为那一行新的第一张。'},
  {t='牛头越少越好',b='每张牌下面标着它的牛头数，收走的牌会把牛头累计到你身上。',
   cards={{55},{11},{10},{5},{7}},n='55 有七个牛头，11 的倍数有五个，10 的倍数有三个，5 的倍数有两个，其他牌各一个。\n单局打完十张就结算；33分和66分模式一直打下去，直到有人累计到 33 或 66 个牛头才结算。\n牛头最少的人获胜。'},
}
local rulePage=1
local rulesOpen=false -- the rules pop-up (launch page / board)
for _,list in ipairs({LAUNCH_WIDGETS,SETUP_WIDGETS,BOARD_WIDGETS,RESULT_WIDGETS}) do
  for _,n in ipairs(list) do ALL_WIDGETS[#ALL_WIDGETS+1]=n end
end
local function control(name) return root:FindChild(name) end
-- Missing controls are skipped, so this script also runs on an older imported
-- template (new widgets just don't show until the template is re-imported).
local function text(name,value) local c=control(name); if c then c.text=tostring(value) end end
-- SKINNED lists labels drawn over a sibling <name>Skin backdrop.
local function visible(name,v) local c=control(name); if c then c:SetActive(v) end; if SKINNED[name] then local s=control(name..'Skin'); if s then s:SetActive(v) end end end
local function click(name,fn) local c=control(name); if c then c:AddCursorEventListener(Enum.CursorEventType.CursorClick,fn) end end
-- Motion: game.Tween (linear by default) on a control's anchored position and
-- the alpha of its colour (packed AARRGGBB). Resting positions are read once
-- and cached, so an interrupted tween never shifts a control for good.
local restPos={}
local tweenWarned=false
local function tweenTry(fn) local ok,e=pcall(fn); if not ok and not tweenWarned then tweenWarned=true; print('[nimmt] tween failed',e) end end
local function rest(c,name)
  local p=restPos[name]
  if not p then p={c.anchoredPositionX,c.anchoredPositionY}; restPos[name]=p end
  return p[1],p[2]
end
local function half(color) return (color & 0x00ffffff) | 0x80000000 end
-- Slide a control in by (dx,dy) px while its colour goes from 50% to 100% alpha.
local function slideIn(name,field,color,dx,dy,dur)
  tweenTry(function()
    local c=control(name); local x,y=rest(c,name)
    c.anchoredPositionX=x+dx; c.anchoredPositionY=y+dy; c[field]=half(color)
    game.Tween(c,{anchoredPositionX=x,anchoredPositionY=y,[field]=color},dur):Play()
  end)
end
local function moveTo(name,dx,dy,dur)
  tweenTry(function()
    local c=control(name); local x,y=rest(c,name)
    game.Tween(c,{anchoredPositionX=x+dx,anchoredPositionY=y+dy},dur):Play()
  end)
end
local INK,HORN,HEAD,WHITE,GOLD,RED=0xff4a3f33,0xffb5483a,0xffc9503f,0xffffffff,0xffb8862a,0xffc9503f
-- A card landing in a board cell: every part of the card moves together.
local function cardIn(cell,dx,dy)
  local d=0.25
  slideIn(cell..'Face','imageColor',WHITE,dx,dy,d)
  slideIn(cell,'fontColor',INK,dx,dy,d)
  slideIn(cell..'Icon','imageColor',HORN,dx,dy,d)
  slideIn(cell..'Heads','fontColor',HEAD,dx,dy,d)
end
local shownRows={{},{},{},{}} -- what each board cell showed last render
local dealtToken -- the hand whose deal animation already played
-- Deal: a hand card starts 24px higher and transparent, then drops in after 'delay'.
local function dealIn(i,delay)
  tweenTry(function()
    local name='Hand'..i; local c=control(name); local x,y=rest(c,name)
    local skin=control(name..'/'..name..'Skin'); local num=control(name..'/'..name..'Text')
    -- only the card face fades: a faded number stayed invisible on the real client (2026-09-27)
    num.fontColor=INK
    c.anchoredPositionY=y+24; skin.imageColor=WHITE & 0x00ffffff
    local seq=game.TweenSequence()
    seq:AppendInterval(delay)
    seq:Append(game.Tween(c,{anchoredPositionY=y},0.22))
    seq:Join(game.Tween(skin,{imageColor=WHITE},0.22))
    seq:Play()
  end)
end
local slotUp={} -- hand slots currently raised
local votedAgain=false -- clicked 再来一局 on this result screen
local fromResult=false -- came back to the setup page from a result-screen vote
local autoWanted=nil -- network 托管 toggle sent but not yet confirmed by the server (true/false)
-- Background music: IDs from the editor's music library (背景音乐管理 → 音乐库).
-- The server plays them for this player only (修改玩家背景音乐).
local MUSIC={10006,10017,10024,10041,10047,10082,10089,10142,10174,10186}
local musicIndex,musicStarted,musicMuted=0,false,false
-- Countdown: turns red for the last 5 seconds.
local function setTimer(s)
  text('Timer',s and timerText(s) or '')
  pcall(function() control('Timer').fontColor=(s and s<=5) and RED or GOLD end)
end
-- Bots: 0 .. 8 - humans (at least 1 when you are the only human, so a match can start).
local function fixBots()
  local humans=1
  if MODE~='practice' and view and view.phase=='lobby' and (view.humans or 0)>0 then humans=view.humans end
  local lo,hi=(humans<=1) and 1 or 0,8-humans
  if bots<lo then bots=lo elseif bots>hi then bots=hi end
end
-- A human seat handed to the AI (left: 2, 托管: 3).
local function isAuto(seat)
  if seat==view.seat and autoWanted~=nil then return autoWanted end
  local b=view.bot and view.bot[seat] or 0
  return b==2 or b==3
end
local function seatName(seat)
  -- rich-text colour tag (official docs: <color=#RRGGBB>..</color>), so only 您 is coloured
  if seat==view.seat then return '<color=#9E2A1E>您</color>' end
  local bot=view.bot and view.bot[seat] or (MODE=='practice' and seat~=1 and 1 or 0)
  if bot==1 then return '电脑'..seat end
  local nick=view.names and view.names[seat] or ''
  local name=(nick~='' and nick) or ('玩家'..seat)
  return name -- 托管 (bot 2/3) is shown by a bot icon next to the name
end
-- Your own name is drawn in its own colour everywhere (a player could be called 您).
local ME_COLOR=0xffc9503f
local function nameColor(name,seat) end -- superseded by the <color> tag in seatName (kept so call sites stay simple)
-- Reveal lane ("待定区"). select: a face-down back per seat that has played
-- (a faint outline for seats still thinking). reveal/resolve/chooseRow: the
-- sorted queue face up; placed cards are gone, the current one has the glow.
local BACK,GHOST=0xff9c7a55,0x40fff8ea
local laneCursor,laneToken
local flying={}
local function laneFly(k,card)
  -- the card that was just placed flies from the lane to its slot
  local cell
  for r=1,4 do for j=1,5 do if view.rows[r][j]==card then cell='Board'..r..'_'..j end end end
  if not cell then return end
  tweenTry(function()
    local f=control('Lane'..k..'Face'); local n=control('Lane'..k)
    local fx,fy=rest(f,'Lane'..k..'Face'); local nx,ny=rest(n,'Lane'..k)
    local tx,ty=rest(control(cell..'Face'),cell..'Face')
    flying[k]=true
    -- nothing of this lane slot may stay behind while its card flies away
    visible('Lane'..k..'Glow',false); visible('Lane'..k..'Check',false); visible('Lane'..k..'Name',false)
    game.Tween(n,{anchoredPositionX=nx+tx-fx,anchoredPositionY=ny+ty-fy},0.35):Play()
    local t=game.Tween(f,{anchoredPositionX=tx,anchoredPositionY=ty},0.35)
    t:SetOnComplete(function()
      flying[k]=nil
      f.anchoredPositionX=fx; f.anchoredPositionY=fy; n.anchoredPositionX=nx; n.anchoredPositionY=ny
      f:SetActive(false); n:SetActive(false)
    end)
    t:Play()
  end)
end
local function renderLane(phase)
  local placing=phase=='reveal' or phase=='resolve' or phase=='chooseRow'
  if placing and laneToken==view.token and laneCursor and view.cursor>laneCursor then
    local item=view.queue[laneCursor]
    if item then laneFly(laneCursor,item.card) end
  end
  laneToken,laneCursor=view.token,(placing and view.cursor or nil)
  for k=1,8 do
    local L='Lane'..k
    if not flying[k] then
      local on,face,num,name,glow=false,WHITE,'','',false
      if phase=='select' then
        on=k<=view.n; face=view.ready[k] and BACK or GHOST; name=seatName(k)
      elseif placing then
        local item=view.queue[k]
        on=item~=nil and k>=view.cursor
        if on then num=tostring(item.card); name=seatName(item.player); glow=k==view.cursor end
      end
      visible(L..'Face',on); visible(L,on); visible(L..'Name',on); visible(L..'Glow',on and glow); if not on then visible(L..'Bot',false) end
      visible(L..'Check',on and phase=='select' and view.ready[k])
      if on then
        text(L,num); text(L..'Name',(name:gsub('%(托管%)','')))
        local owner=phase=='select' and k or (view.queue[k] and view.queue[k].player)
        nameColor(L..'Name',owner)
        visible(L..'Bot',owner~=nil and isAuto(owner))
        tweenTry(function() control(L..'Face').imageColor=face end)
      end
    end
  end
end
-- Practice: any seat other than your own, or your own once handed to the AI, plays itself.
local function autoSeat(p) return p~=1 or not selfControlled end
local function scoreboardLines(highlightWinners)
  local order={}; for i=1,view.n do order[i]=i end
  table.sort(order,function(a,b) return view.scores[a]<view.scores[b] end)
  local lines={}
  for rank,seat in ipairs(order) do
    local win=false
    if highlightWinners then for _,w in ipairs(view.winners) do if w==seat then win=true end end end
    lines[#lines+1]=rank..'. '..seatName(seat)..'   '..view.scores[seat]..' 分'..(win and '  ★ 获胜' or '')
  end
  return table.concat(lines,'\n')
end
local function showCard(prefix,card)
  local has=card~=nil
  text(prefix,has and card or '')
  text(prefix..'Heads',has and ('×'..Core.points(card)) or '')
  return has
end
-- Network lobby: everyone is ready, so the server is starting the deal.
local function dealing()
  if MODE=='practice' or not view or view.phase~='lobby' or view.n<1 then return false end
  for p=1,view.n do if not ((p==view.seat and ready) or (p~=view.seat and view.ready[p])) then return false end end
  return true
end
-- Fill a scoreboard: rows <prefix>Rank/Name/Horn/Score k, sorted by bull heads (ties share a rank).
local function fillScoreRows(prefix,on)
  local order={}; if on and view then for i=1,view.n do order[i]=i end end
  table.sort(order,function(a,b) if view.scores[a]~=view.scores[b] then return view.scores[a]<view.scores[b] end return a<b end)
  local rank=0
  for k=1,8 do
    local seat=order[k]
    for _,s in ipairs({'Rank','Name','Horn','Score'}) do visible(prefix..s..k,seat~=nil) end
    if seat then
      if k==1 or view.scores[seat]~=view.scores[order[k-1]] then rank=k end
      text(prefix..'Rank'..k,'第'..rank..'名'); text(prefix..'Name'..k,seatName(seat)); text(prefix..'Score'..k,tostring(view.scores[seat]))
    end
  end
end
local function render()
  visible('UiToggle',true)
  if uiHidden then
    for _,n in ipairs(ALL_WIDGETS) do visible(n,false) end
    text('UiToggle/UiToggleText','双击显示')
    return
  end
  text('UiToggle/UiToggleText','隐藏')
  -- the toggle lives in the board's icon column; outside the board it stays hidden
  visible('UiToggle',uiHidden or scene=='board')
  visible('Background',true)
  for _,n in ipairs(EMOTE_PARTS) do visible(n,emotePanelOpen and scene=='board') end
  -- fake exit tile: always on the setup page, in the match only after 30 s
  for _,n in ipairs(EXIT_PARTS) do visible(n,exitShown or scene=='setup') end
  for _,n in ipairs(RULE_WIDGETS) do visible(n,rulesOpen) end
  if rulesOpen then
    local pg=RULE_PAGES[rulePage]
    text('RulesTitle',pg.t); text('RulesPage',rulePage..' / '..#RULE_PAGES); text('RulesText',pg.b); text('RulesNote',pg.n)
    visible('RulesPrev',rulePage>1); visible('RulesNext',rulePage<#RULE_PAGES)
    -- rows diagram (only pages with pg.rows)
    for r=1,4 do
      local row=pg.rows and pg.rows[r] or {}
      for j=1,5 do
        local n=row[j]
        visible('RuleRow'..r..'_'..j,n~=nil); visible('RuleRowFace'..r..'_'..j,n~=nil)
        if n then
          text('RuleRow'..r..'_'..j,tostring(n))
          local grey=pg.grey and pg.grey[r]
          tweenTry(function() control('RuleRowFace'..r..'_'..j).imageColor=grey and 0xff9a9a9a or 0xffffffff end)
        end
      end
      local isTarget=pg.rows~=nil and pg.target==r
      visible('RuleRowRim'..r,isTarget)
      if isTarget then tweenTry(function() local rim=control('RuleRowRim'..r); local x,_=rest(rim,'RuleRowRim'..r); rim.anchoredPositionX=x+(#row-1)*31 end) end
    end
    for _,n in ipairs({'RuleMineLabel','RuleMine','RuleMineFace','RuleMineRim'}) do visible(n,pg.mine~=nil) end
    if pg.mine then text('RuleMine',tostring(pg.mine)) end
    local k=#pg.cards; local first=4-math.floor((k-1)/2)
    for i=1,7 do
      local c=pg.cards[i-first+1]
      for _,s in ipairs({'RuleCard','RuleHorn','RuleHeads','RuleFace'}) do visible(s..i,c~=nil) end
      visible('RuleRim'..i,c~=nil and c[2]=='play')
      if c then
        text('RuleCard'..i,tostring(c[1])); text('RuleHeads'..i,'×'..Core.points(c[1]))
        tweenTry(function() control('RuleFace'..i).imageColor=(c[2]=='take') and 0xff9a9a9a or 0xffffffff end)
      end
    end
  end
  local onLaunch,onSetup,onBoard,onOver=scene=='launch',scene=='setup',scene=='board',scene=='gameover'
  for _,n in ipairs(LAUNCH_WIDGETS) do visible(n,onLaunch) end
  for _,n in ipairs(SETUP_WIDGETS) do visible(n,onSetup) end
  if onSetup then
    fixBots() -- keep the count inside 0..8-humans as players come and go
    text('BotsCount','×'..bots)
    text('ModeStep/ModeStepText','模式：'..MODE_NAME[mode])
    -- Green SetupBegin = the ready toggle; red ReadyToggle = read-only status
    -- (ready count, then the auto-start countdown). Humans: just this client
    -- until the server tracks lobby readiness.
    text('SetupBegin/SetupBeginText',(not lobbyLoaded()) and '请稍候' or (ready and '已准备' or '准备'))
    local host=MODE=='practice' or not view or view.seat==1
    -- only the host sees the steppers and the mode-switch mark; others just read the values
    visible('BotsMinus',host); visible('BotsPlus',host); visible('ModeSync',host)
    text('SetupHint',(fromResult and '不想继续可点左上角退出按钮离开 · ' or '')..(host and '全员准备后自动开局' or '机器人数量和模式由房主设置 · 全员准备后自动开局'))
    local status='已准备 '..(ready and 1 or 0)..'/1'
    if MODE~='practice' then
      local r,h=0,0
      -- Own seat counts from the local toggle: a lone player's ready starts the
      -- match on the server before the "1/1" state is ever published.
      if view and view.phase=='lobby' then
        h=view.n
        for p=1,view.n do if (p==view.seat and ready) or (p~=view.seat and view.ready[p]) then r=r+1 end end
      end
      -- until the server's first lobby snapshot arrives
      if not lobbyLoaded() and h>=1 and (view.expected or 0)<=h then status='正在布置牌桌' -- not seated / not in the lobby yet
      elseif h<1 then status='正在布置牌桌'
      elseif (view.expected or 0)>h then status='等待玩家加载 '..h..'/'..view.expected
      elseif r>=h then status='正在发牌…'
      else status='已准备 '..r..'/'..h end
    elseif starting then status='正在发牌…'
    elseif countdown then status=math.ceil(countdown)..' 秒后开局' end
    text('ReadyToggle/ReadyToggleText',status)
  end
  for _,name in ipairs(BOARD_WIDGETS) do visible(name,onBoard) end
  if onBoard and not view then
    text('Status','正在同步牌桌…'); text('Config',''); text('ModeNote','联机对局')
    for i=1,10 do visible('Hand'..i,false) end
    for p=1,8 do for _,s in ipairs({'','Score','Horn','Gain','Bot','Emote','EmoteBg','EmoteTail','EmoteEdge','EmoteTailEdge'}) do visible('Player'..p..s,false) end end
    for r=1,4 do for j=1,5 do local cell='Board'..r..'_'..j; visible(cell..'Face',false); visible(cell..'Icon',false); text(cell,''); text(cell..'Heads','') end end
    visible('Confirm',false); visible('HandEndBoard',false); visible('Next',false); visible('HandOver',false)
  elseif onBoard then
    text('Config','第'..view.handNo..'局 · 第'..view.round..'/10张')
    text('ModeNote',MODE_NAME[view.mode] or '')
    if autoWanted~=nil and view.seat>0 and ((view.bot[view.seat]==3)==autoWanted) then autoWanted=nil end -- server caught up
    local onAuto=(MODE=='practice' and not selfControlled) or (MODE~='practice' and view.seat>0 and (autoWanted~=nil and autoWanted or (autoWanted==nil and view.bot[view.seat]==3)))
    text('HandOver/HandOverText',onAuto and '接管' or '托管')
    visible('HandOver',view.phase~='gameOver' and (MODE=='practice' or view.seat>0))
    local phase=view.phase
    local locked=view.ready[view.seat] or (sentCard~=nil and sentToken==view.token)
    local mine=(view.locked and view.locked~=0 and view.locked) or ((playedToken==view.token) and playedCard) or nil
    local myChoice=phase=='chooseRow' and view.waiting==view.seat
    local choosing=view.queue[view.cursor]
    local status='同时选牌，从小到大落位。第六张，收走这一行。'
    if phase=='select' then
      status=locked and ('已出牌'..(mine and (' '..mine) or '')..'，等待其他人…') or '选一张手牌，点「确认出牌」'
    elseif myChoice then
      status=sentRow and '已选择，正在收走该行…' or ('你的 '..(choosing and choosing.card or '')..' 太小，选一行收走')
    elseif phase=='chooseRow' then
      status=seatName(view.waiting)..' 的 '..(choosing and choosing.card or '')..' 太小，正在选行…'
    elseif phase=='handEnd' then status='10张出完，本局结束 · 即将洗牌重发'
    else status='全员亮牌，从小到大落位' end
    if onAuto and phase~='handEnd' then status='【托管中】'..status end
    text('Status',status)
    local counting=phase=='select' or phase=='chooseRow'
    if MODE=='practice' then setTimer(counting and math.max(0,math.ceil(deadline or 30)) or nil)
    else setTimer(counting and math.max(0,math.ceil(timerLeft)) or nil) end
    -- clock icon (only in templates built with ASSET.clock set) follows the timer
    visible('TimerIcon',counting)
    for r=1,4 do
      local row=view.rows[r]
      text('RowLabel'..r,'×'..Core.rowPoints(row))
      visible('RowAction'..r,myChoice and not sentRow)
      local was=shownRows[r]
      -- the row was taken / restarted: its new cards come in sideways
      local taken=was[1]~=nil and row[1]~=was[1]
      for j=1,5 do
        local cell='Board'..r..'_'..j
        local has=showCard(cell,row[j])
        visible(cell..'Face',has); visible(cell..'Icon',has)
        if has and row[j]~=was[j] then
          if taken then cardIn(cell,24,0) else cardIn(cell,0,10) end
        end
      end
      local copy={}; for j=1,5 do copy[j]=row[j] end; shownRows[r]=copy
    end
    for i=1,10 do
      local c=view.hand[i]
      visible('Hand'..i,c~=nil)
      if c then
        showCard('Hand'..i..'/Hand'..i..'Text',c); visible('Hand'..i..'/Hand'..i..'Glow',(locked and c==mine) or (not locked and c==selected))
        tweenTry(function() control('Hand'..i..'/Hand'..i..'Text').fontColor=INK end) -- the number is never left transparent
      end
    end
    if phase=='select' and view.round==1 and view.token~=dealtToken and #view.hand>0 then
      dealtToken=view.token
      for i=1,#view.hand do dealIn(i,(i-1)*0.08) end
    end
    local lift=(locked and mine) or (not locked and selected) or nil
    for i=1,10 do
      local c=view.hand[i]; local up=c~=nil and c==lift
      if up~=(slotUp[i]==true) then moveTo('Hand'..i,0,up and 10 or 0,0.12); slotUp[i]=up end
    end
    visible('Confirm',phase=='select' and not locked and not onAuto and view.seat>0)
    text('Confirm/ConfirmText',selected and ('确认出牌 '..selected) or '先选择手牌')
    local tookHeads=false
    for p=1,view.n do
      local s=view.scores[p]; local was=lastScores[p]
      if was~=nil and s>was then gains[p]={amount=s-was,untilT=clock+5}; tookHeads=true elseif was~=nil and s<was then gains[p]=nil end
      lastScores[p]=s
    end
    if tookHeads then playRandom(SFX_BULL) end
    local rank={}; for p=1,view.n do rank[p]=p end
    table.sort(rank,function(a,b) if view.scores[a]~=view.scores[b] then return view.scores[a]<view.scores[b] end return a<b end)
    for p=1,8 do
      visible('Player'..p,p<=view.n)
      local q=rank[p]
      for _,s in ipairs({'Score','Horn'}) do visible('Player'..p..s,q~=nil) end
      -- +X for 5 s after this seat took bull heads
      local g=q and gains[q]
      local showGain=g~=nil and g.untilT>clock
      visible('Player'..p..'Gain',showGain)
      if showGain then text('Player'..p..'Gain','+'..g.amount) end
      visible('Player'..p..'Bot',q~=nil and isAuto(q))
      local em=q and emoteShow[q]
      local showEm=em~=nil and em.untilT>clock
      for _,s in ipairs({'Emote','EmoteBg','EmoteTail','EmoteEdge','EmoteTailEdge'}) do visible('Player'..p..s,showEm) end
      if showEm and em.row~=p then
        -- (re)bind the image to this row and pop it out to the left, inside the panel
        em.row=p
        tweenTry(function() control('Player'..p..'Emote'):SetImage(Enum.ImageSource.StaticReference,em.img) end)
      end
      if q then text('Player'..p,seatName(q)); text('Player'..p..'Score',tostring(view.scores[q])); nameColor('Player'..p,q) end
    end
    renderLane(phase)
    local log={}; for i=math.max(1,#view.events-2),#view.events do log[#log+1]=view.events[i] end
    text('Log','')
    local atHandEnd=phase=='handEnd'
    visible('HandEndBoard',atHandEnd); visible('Next',atHandEnd and MODE=='practice')
    if atHandEnd then text('HandEndBoard','第'..view.handNo..'局结束（牛头越少越好），洗牌后开始下一局') end
    fillScoreRows('HandEnd',atHandEnd)
  end
  for _,n in ipairs(RESULT_WIDGETS) do visible(n,onOver) end
  if onOver then
    -- 30 s vote: more than half clicking 再来一局 goes back to the setup page, otherwise everyone is settled
    local net=MODE~='practice' and view~=nil and view.seat>0
    visible('ResultVote',net)
    if net then
      local again=0; for p=1,view.n do if view.bot[p]~=1 and view.voted[p]==1 then again=again+1 end end
      local mine=view.voted[view.seat]==1 or votedAgain
      text('ReplayButton/ReplayButtonText',mine and '已选择再来一局' or '再来一局')
      text('ResultVote',math.max(0,math.ceil(timerLeft))..' 秒 · 已有 '..again..'/'..view.humans..' 人选择再来一局'..'\n'..'过半数继续游戏，否则退出结算。不想玩可以左上角结算。')
    end
  end
  if onOver then
    local reason=view and view.endReason or ''
    text('ResultReason',({rounds='十轮已全部完成',score='已有玩家达到 '..((view and view.mode=='short') and 33 or 66)..' 牛头',vote='投票通过，提前结算'})[reason] or '对局已结束')
    -- older imported templates only have the single ResultBoard text
    if not control('ResultRank1') then visible('ResultBoard',true); text('ResultBoard',view and scoreboardLines(true) or '') end
    fillScoreRows('Result',true)
  end
end
local function refresh()
  if state then view=Core.view(state,1) end
  if state and state.phase=='gameOver' then scene='gameover' end
  if view and view.phase~=lastPhase then deadline=30; elapsed=0; lastPhase=view.phase end
  render()
end
-- network intents all go through NimmtAct(seat, key, kind, token, value); the
-- key was written privately into this player's nimmt_me by the server and is
-- how the server knows who sent it (see docs/server-contract.md).
local ACT_SUBMIT,ACT_ROW,ACT_VOTE,ACT_READY,ACT_SETTINGS,ACT_AUTO,ACT_MUSIC,ACT_EMOTE=1,2,3,4,5,6,7,8
local function act(kind,value)
  if not view or view.seat<1 then return end
  local signal=game.ServerSignal('NimmtAct')
  for _,v in ipairs({view.seat,view.key,kind,view.token,value}) do signal:AddInt(v) end
  signal:SendSignal()
end
local function readyValue(on) return (on and 1 or 0)+10*bots+100*MODE_NUM[mode] end
-- Network: bots/mode are one shared lobby setting on the server (changing it un-readies everyone).
-- A local change wins until the server publishes it back (or 3 s pass), so a
-- publish still carrying the old value can't snap the stepper back.
local settingsSentAt,settingsSent=-100,nil
local function sendSettings()
  if MODE=='practice' then return end
  settingsSent=bots+10*MODE_NUM[mode]; settingsSentAt=os.clock()
  act(ACT_SETTINGS,10*settingsSent)
end
local function request(name,...)
  local signal=game.ServerSignal(name)
  for _,v in ipairs({...}) do signal:AddInt(v) end
  signal:SendSignal()
end

-- ---- network: read the server's custom variables ---------------------------
-- Layout (0-based, must match server-graph/src/main.ts PUB_* constants):
-- Level.nimmt_pub  IntList(96): 0 n,1 handNo,2 round,3 token,4 revision,5 cursor,
--   6 waiting,7 humans,8 votesEnd,9 votesLeave,10 secondsLeft,11 reserved,
--   12-31 rows (row r slot j at 12+(r-1)*5+(j-1), 0 = empty), 32-39 scores,
--   40-47 counts, 48-55 ready(0/1), 56-63 bot(0 human/1 bot/2 left→AI),
--   64-71 voted(0/1 end/2 leave), 72-79 queueCard, 80-87 queuePlayer, 88-95 winners
-- Level.nimmt_text StringList(6): phase, mode, endReason, event1, event2, event3
-- PlayerSelf.nimmt_me IntList(12): seat, hand1..hand10 (0 = empty), key
-- Level.nimmt_rev  Int: bumped last on every publish; this client listens to it.
local VT=Enum.CustomVariableEntityType
local function readVar(entityType,name)
  local ok,value=pcall(game.GetGlobalCustomVariableValue,entityType,name)
  if ok then return value end
end
local function viewFromVars()
  local pub,txt,me=readVar(VT.Level,'nimmt_pub'),readVar(VT.Level,'nimmt_text'),readVar(VT.PlayerSelf,'nimmt_me')
  print('[nimmt] vars pub='..typeof(pub)..' text='..typeof(txt)..' me='..typeof(me))
  if pub==nil or txt==nil then return nil end
  local ok,v=pcall(function()
    local function P(i) return pub[i+1] or 0 end
    local function T(i) return txt[i+1] or '' end
    local function M(i) return me and me[i+1] or 0 end
    local n=P(0)
    local v={n=n,handNo=P(1),round=P(2),token=P(3),revision=P(4),cursor=P(5),waiting=P(6),humans=P(7),
      votesEnd=P(8),expected=P(8),emotes=P(9),votesLeave=P(9),secondsLeft=P(10),settings=P(11),phase=T(0),mode=T(1),endReason=T(2),seat=M(0),key=M(11),locked=M(12),
      hand={},rows={},scores={},counts={},ready={},bot={},voted={},queue={},winners={},events={},names={}}
    for p=1,8 do v.names[p]=T(5+p) end
    for i=1,10 do local c=M(i); if c~=0 then v.hand[#v.hand+1]=c end end
    for r=1,4 do v.rows[r]={}; for j=1,5 do local c=P(12+(r-1)*5+(j-1)); if c~=0 then table.insert(v.rows[r],c) end end end
    for p=1,8 do
      v.scores[p]=P(31+p); v.counts[p]=P(39+p); v.ready[p]=P(47+p)~=0; v.bot[p]=P(55+p); v.voted[p]=P(63+p)
      local qc,qp=P(71+p),P(79+p); if qp~=0 then v.queue[#v.queue+1]={card=qc,player=qp} end
      local w=P(87+p); if w~=0 then v.winners[#v.winners+1]=w end
    end
    for i=3,5 do local e=T(i); if e~='' then v.events[#v.events+1]=e end end
    return v
  end)
  if not ok then printerr('[nimmt] decode failed: '..tostring(v)) end
  if ok and v.n>=1 then return v end
end
-- Emotes arrive on their own Level variable nimmt_emo (IntList 8, seq*10+emote per
-- seat) so they show immediately instead of waiting for the table publish.
local emoBaselined=false
local liveLock={}   -- per seat: token of the round it locked a card in (nimmt_emo[9..16])
-- Fold the instant lock marks into view.ready (they beat the slow table publish).
local function mergeLive()
  if not view then return false end
  local changed=false
  for p=1,view.n do
    if liveLock[p]~=nil and liveLock[p]==view.token and view.phase=='select' and not view.ready[p] then view.ready[p]=true; changed=true end
  end
  return changed
end
local function onEmo()
  local list=readVar(VT.Level,'nimmt_emo')
  if list==nil then emoBaselined=true; return end -- nobody has emoted yet
  local fresh=0
  for p=1,8 do liveLock[p]=list[8+p] end
  local lockChanged=mergeLive()
  for p=1,8 do
    local code=list[p] or 0
    local prev=seenEmote[p]; if prev==nil and emoBaselined then prev=0 end
    if prev~=nil and code~=prev and code%10>=1 and EMOTE_IMG[code%10] then
      emoteShow[p]={img=EMOTE_IMG[code%10],untilT=clock+3}
      fresh=fresh+1
    end
    seenEmote[p]=code
  end
  emoBaselined=true
  if fresh>0 then playRandom(SFX_EMOTE) end
  if (fresh>0 or lockChanged) and scene=='board' then render() end
end
local function onVars()
  local v=viewFromVars()
  if not v then return end
  view=v
  mergeLive()
  if MODE~='practice' and not musicStarted and v.seat>0 then
    musicStarted=true; musicIndex=1; act(ACT_MUSIC,MUSIC[1]); text('MusicButton/MusicButtonText','音乐1')
  end
  -- Take the server's secondsLeft once per decision (token + phase), then count
  -- down locally: the server derives it from tick counts and its ticks run
  -- slower than nominal, so re-syncing every publish made the display jump back.
  local key=v.token..':'..v.phase
  if key~=timerKey then timerKey=key; timerLeft=v.secondsLeft; timerShown=-1 end
  if v.phase~='lobby' and v.phase~='' then starting=false end
  if sentToken~=v.token or v.ready[v.seat] then sentCard=nil end
  if v.phase~='chooseRow' or sentToken~=v.token then sentRow=nil end
  if selected then
    local still=false; for _,c in ipairs(view.hand) do if c==selected then still=true end end
    if not still or view.phase~='select' or view.ready[view.seat] then selected=nil end
  end
  if view.phase~='gameOver' then votedAgain=false end
  if view.phase=='gameOver' then scene='gameover'
  elseif view.phase=='lobby' then
    if scene=='gameover' then fromResult=true end
    if scene=='board' or scene=='gameover' then scene='setup' end
    if view.seat>0 then
      -- Follow the server, except that a ready we just sent stays on for 3 s so a
      -- publish that predates it can't flip us back (the server's flag lags).
      ready=view.ready[view.seat] or (ready and os.clock()-readySentAt<3)
    end
    if view.settings==settingsSent or os.clock()-settingsSentAt>3 then
      settingsSent=nil
      bots=view.settings%10; mode=MODE_OF[math.floor(view.settings/10)] or 'quick'; fixBots()
    end
  elseif view.phase~='' then scene='board' end
  render()
end
-- ----------------------------------------------------------------------------

local function startMatch()
  countdown=nil; ready=false
  if MODE~='practice' then return end
  seed=seed+1; state=Core.new(1+bots,seed,mode); selfControlled=true
  selected=nil; lastPhase=nil; scene='board'; refresh()
end
local function autoSubmitRound()
  for p=1,state.n do if autoSeat(p) and not state.pending[p] then Core.submit(state,p,Core.bot(Core.view(state,p)),state.token) end end
end
local function chooseCard(i)
  if scene~='board' or not selfControlled or not view or view.phase~='select' or view.ready[view.seat] then return end
  if sentCard~=nil and sentToken==view.token then return end
  selected=view.hand[i]; render()
end
local function confirm()
  if scene~='board' or not selfControlled or not selected or not view or view.phase~='select' or view.ready[view.seat] then return end
  if MODE=='practice' then autoSubmitRound(); Core.submit(state,1,selected,state.token)
  else act(ACT_SUBMIT,selected); sentCard=selected; sentToken=view.token end
  playedCard=selected; playedToken=view.token
  selected=nil; refresh()
end
-- The game's own exit (top-left) and chat (bottom-left) buttons sit at the real
-- screen corners, while our 1280x720 page is scaled to fit and centred. Move the
-- two decoration tiles so they stay on those buttons on any aspect ratio
-- (16:10, 21:9 ...). Assumes the game HUD scales with screen height like a
-- 720-high reference; tweak HUD_* below if a device shows an offset.
local HUD_EXIT_X,HUD_EXIT_Y=38,30     -- from the top-left corner, 720-high units
local HUD_CHAT_X,HUD_CHAT_B=39,27     -- from the bottom-left corner
local function pinCornerDecos(w,h,scale)
  local k=h/720 -- HUD units -> canvas units
  local function place(names,sx,sy) -- sx,sy: canvas position measured from the top-left
    local x=(sx-w/2)/scale+640; local y=(sy-h/2)/scale+360 -- back into our 1280x720 page
    for _,n in ipairs(names) do
      local c=control(n)
      if c then
        local rx,ry=rest(c,n) -- authored position (centre-relative, y up)
        local ax,ay=x-640,360-y
        -- every part of a tile shares the tile's centre, so move by the same delta
        local base=restPos[names[1]]
        local dx,dy=ax-base[1],ay-base[2]
        c.anchoredPositionX=rx+dx; c.anchoredPositionY=ry+dy
      end
    end
  end
  local okE=pcall(function() rest(control('ExitDecoIcon'),'ExitDecoIcon') end)
  local okC=pcall(function() rest(control('ChatDecoIcon'),'ChatDecoIcon') end)
  if okE then place({'ExitDecoIcon','ExitDecoFill','ExitDecoEdge'},HUD_EXIT_X*k,HUD_EXIT_Y*k) end
  if okC then place({'ChatDecoIcon','ChatDecoFill','ChatDecoEdge'},HUD_CHAT_X*k,h-HUD_CHAT_B*k) end
  print('[nimmt] canvas',w,h,'scale',scale)
end
-- Border mascots: tilt each one by a different angle (rotation can't be authored in the GIA).
function tiltBoardDecor()
  for i=1,20 do
    for _,side in ipairs({'T','B'}) do
      local ok,c=pcall(control,'BoardDeco'..side..i)
      if ok and c then pcall(function() c.localRotationZ=((i*37+(side=='B' and 19 or 0))%51)-25 end) end
    end
  end
end
function OnStart()
  root=script.object; root.showCursor=true
  -- Apply the authored stacking (LAYERS, prepended by the build: front-to-back
  -- per parent). SetAsFirstSibling sends a control to the bottom, so walking
  -- front-to-back leaves the first-authored control on top. Explicit, so it
  -- holds however the imported template stored its child order.
  for _,group in ipairs(LAYERS) do
    for _,name in ipairs(group[2]) do
      local c=root:FindChild(group[1]=='' and name or (group[1]..'/'..name))
      if c then c:SetAsFirstSibling() end
    end
  end
  local w,h=game.GetUICanvasSize(); local scale=math.min(w/1280,h/720); root.localScaleX=scale; root.localScaleY=scale
  pinCornerDecos(w,h,scale)
  tiltBoardDecor()
  scene='setup' -- no title page any more
  for _,n in ipairs(EXIT_PARTS) do visible(n,false) end
  click('LaunchStart',function()
    scene='setup'; ready=false; countdown=nil
    -- network: (re)open the server lobby, e.g. after Home from the result screen
    if MODE~='practice' and view and view.phase=='gameOver' then act(ACT_READY,readyValue(false)) end
    render()
  end)
  -- once you are ready your settings are locked (there is no "cancel ready" any more)
  local function isHost() return MODE=='practice' or not view or view.seat==1 end
  click('BotsMinus',function() if ready or not isHost() then return end; bots=bots-1; fixBots(); sendSettings(); countdown=nil; render() end)
  click('BotsPlus',function() if ready or not isHost() then return end; bots=bots+1; fixBots(); sendSettings(); countdown=nil; render() end)
  click('ModeStep',function() if ready or not isHost() then return end; mode=MODE_NEXT[mode]; sendSettings(); countdown=nil; render() end)
  click('SetupBegin',function()
    if starting or not lobbyLoaded() then return end -- still waiting for players to load in
    -- Idempotent: every press (re)asserts "ready"; it can never un-ready.
    ready=true
    if MODE=='practice' then countdown=COUNTDOWN_SECONDS else readySentAt=os.clock(); act(ACT_READY,readyValue(true)) end
    render()
  end)
  click('MuteButton',function()
    musicMuted=not musicMuted
    if MODE~='practice' then act(ACT_MUSIC,musicMuted and 0 or (MUSIC[musicIndex] or MUSIC[1])) end
    text('MuteButton/MuteButtonText',musicMuted and '取消静音' or '静音')
  end)
  click('EmoteButton',function() emotePanelOpen=not emotePanelOpen; render() end)
  for k=1,8 do local idx=k; click('Emote'..k,function()
    emotePanelOpen=false
    if MODE~='practice' and view and view.seat>0 and clock-lastEmoteSent>=2 then
      lastEmoteSent=clock; act(ACT_EMOTE,idx)
    end
    render()
  end) end
  click('SetupRules',function() rulesOpen=true; rulePage=1; render() end)
  -- Music: each click goes to the next track, after the last one it turns music off.
  click('MusicButton',function()
    musicIndex=musicIndex+1
    if musicIndex>#MUSIC then musicIndex=1 end
    musicMuted=false
    if MODE~='practice' then act(ACT_MUSIC,MUSIC[musicIndex]) end
    text('MusicButton/MusicButtonText','音乐'..musicIndex); text('MuteButton/MuteButtonText','静音')
    print('[nimmt] music',musicIndex,MUSIC[musicIndex])
  end)
  local function showRules(v) rulesOpen=v; if v then rulePage=1 end; render() end
  click('RulesPrev',function() if rulePage>1 then rulePage=rulePage-1; render() end end)
  click('RulesNext',function() if rulePage<#RULE_PAGES then rulePage=rulePage+1; render() end end)
  click('LaunchRules',function() showRules(true) end)
  click('RulesButton',function() showRules(not rulesOpen) end)
  click('RulesClose',function() showRules(false) end)
  -- The hide toggle is disabled on purpose (2026-10-01): hiding the overlay
  -- showed the bare world around the table. The button stays but does nothing.
  click('UiToggle',function() end)
  click('HandOver',function()
    if MODE~='practice' then
      if view and view.seat>0 then
        local now=autoWanted; if now==nil then now=view.bot[view.seat]==3 end
        autoWanted=not now; act(ACT_AUTO,autoWanted and 1 or 0); selected=nil; render()
      end
      return
    end
    if not state then return end
    selfControlled=not selfControlled; selected=nil
    if not selfControlled then autoSubmitRound() end
    refresh()
  end)
  click('ReplayButton',function() if MODE=='practice' then startMatch() elseif view and view.phase=='gameOver' and not votedAgain then votedAgain=true; act(ACT_VOTE,1); render() end end) -- back to the lobby; everyone readies again
  click('Next',function() if state then Core.nextHand(state); selected=nil; refresh() end end)
  click('Confirm',confirm)
  for i=1,10 do local index=i; click('Hand'..i,function() chooseCard(index) end) end
  for r=1,4 do local index=r; click('RowAction'..r,function()
    if scene~='board' or not view or view.phase~='chooseRow' or view.waiting~=view.seat or not selfControlled then return end
    if MODE=='practice' then Core.choose(state,1,index,state.token) else act(ACT_ROW,index); sentRow=index; sentToken=view.token end; refresh()
  end) end
  if MODE~='practice' then
    script:RegisterCustomVariableChangedHandler(VT.Level,'nimmt_rev',onVars)
    script:RegisterCustomVariableChangedHandler(VT.PlayerSelf,'nimmt_me',onVars)
    script:RegisterCustomVariableChangedHandler(VT.Level,'nimmt_emo',onEmo)
    onEmo() -- baseline: emotes sent before we joined are not replayed
    onVars() -- a reconnecting client picks the match straight back up from the server's variables
    request('NimmtSync') -- and asks the server to republish its private hand
  end
  script:EnableUpdate(true); render(); print('sixnimmt ready',MODE)
end
function OnUpdate(dt)
  clock=clock+dt
  -- hide a +X once its 5 s are up
  for seat,g in pairs(gains) do if g.untilT<=clock then gains[seat]=nil; if scene=='board' then render() end end end
  for seat,e in pairs(emoteShow) do if e.untilT<=clock then emoteShow[seat]=nil; if scene=='board' then render() end end end
  if not exitShown then
    levelTime=levelTime+dt
    if levelTime>=30 then exitShown=true; for _,n in ipairs(EXIT_PARTS) do visible(n,true) end end
  end
  if scene=='setup' and countdown then
    countdown=countdown-dt
    if countdown<=0 then startMatch(); return end
    text('ReadyToggle/ReadyToggleText',math.ceil(countdown)..' 秒后开局')
    return
  end
  if MODE~='practice' then
    if view and scene=='board' and not uiHidden and (view.phase=='select' or view.phase=='chooseRow') then
      timerLeft=math.max(0,timerLeft-dt)
      local s=math.ceil(timerLeft)
      if s~=timerShown then timerShown=s; setTimer(s) end
    elseif view and scene=='gameover' and view.phase=='gameOver' then
      timerLeft=math.max(0,timerLeft-dt)
      local s=math.ceil(timerLeft)
      if s~=timerShown then timerShown=s; render() end
    end
    return
  end
  if not state or scene~='board' then return end
  elapsed=elapsed+dt
  if state.phase=='select' or state.phase=='chooseRow' then
    if not selfControlled then
      if elapsed>=0.5 then
        if state.phase=='select' then autoSubmitRound() else Core.choose(state,state.waiting,Core.bestRow(state.rows),state.token) end
        elapsed=0; selected=nil; refresh()
      end
    else
      deadline=deadline-dt
      if deadline<=0 then Core.timeout(state,state.token); selected=nil; lastPhase=nil; refresh()
      elseif state.phase=='chooseRow' and state.waiting~=1 and elapsed>=0.65 then Core.choose(state,state.waiting,Core.bestRow(state.rows),state.token); refresh()
      else setTimer(math.max(0,math.ceil(deadline))) end
    end
  elseif (state.phase=='resolve' or state.phase=='reveal') and elapsed>=0.75 then
    elapsed=0; Core.step(state); selected=nil; refresh()
  end
end
function OnDestroy()
  if MODE~='practice' then
    script:UnregisterCustomVariableChangedHandler(VT.Level,'nimmt_rev')
    script:UnregisterCustomVariableChangedHandler(VT.PlayerSelf,'nimmt_me')
    script:UnregisterCustomVariableChangedHandler(VT.Level,'nimmt_emo')
  end
end
