-- Pure Lua 5.3 rules. Server reference / local practice ONLY, never ship hidden state to multiplayer clients.
local M = {}
local function copy(v)
  if type(v) ~= 'table' then return v end
  local out = {}; for k,x in pairs(v) do out[k] = copy(x) end; return out
end
M.copy = copy
local function integer(n) return type(n)=='number' and n==math.floor(n) end
function M.points(n)
  if n==55 then return 7 elseif n%11==0 then return 5 elseif n%10==0 then return 3 elseif n%5==0 then return 2 end
  return 1
end
function M.rowPoints(row) local p=0; for _,c in ipairs(row) do p=p+M.points(c) end; return p end
local function rand(s,n) s.rng=(s.rng*16807.0)%2147483647; return math.floor(s.rng%n)+1 end
local function note(s,text) table.insert(s.events,text); if #s.events>12 then table.remove(s.events,1) end end
local function deal(s)
  s.handNo=s.handNo+1; s.round=1; s.token=s.token+1; s.phase='select'; s.pending={}; s.queue={}; s.cursor=1; s.taken={}; s.events={}; s.hands={}; s.rows={}; s.waiting=0; s.endReason=''
  local deck={}; for i=1,104 do deck[i]=i end
  for i=104,2,-1 do local j=rand(s,i); deck[i],deck[j]=deck[j],deck[i] end
  for p=1,s.n do s.hands[p]={}; for i=1,10 do table.insert(s.hands[p],table.remove(deck)) end; table.sort(s.hands[p]) end
  for r=1,4 do s.rows[r]={table.remove(deck)} end
  table.sort(s.rows,function(a,b) return a[1]<b[1] end); s.undealt=deck
  note(s,'第 '..s.handNo..' 手开始：所有人秘密选牌')
end
function M.new(n,seed,mode)
  assert(integer(n) and n>=2 and n<=8,'人数必须为 2–8')
  assert(mode==nil or mode=='quick' or mode=='standard','未知模式')
  local s={n=n,rng=(tonumber(seed) or 1)%2147483647,mode=mode or 'quick',scores={},handNo=0,token=0,revision=0}
  if s.rng<1 then s.rng=1 end
  for p=1,n do s.scores[p]=0 end; deal(s); return s
end
local function valid(s,p,token,phase)
  if not integer(p) or p<1 or p>s.n then return false,'invalid_player' end
  if token~=s.token then return false,'stale_turn' end
  if s.phase~=phase then return false,'wrong_phase' end
  return true
end
function M.submit(s,p,card,token)
  local ok,err=valid(s,p,token,'select'); if not ok then return false,err end
  if s.pending[p] then return false,'already_submitted' end
  local found=false; for _,c in ipairs(s.hands[p]) do if c==card then found=true end end
  if not found then return false,'card_not_owned' end
  s.pending[p]=card; s.revision=s.revision+1
  for i=1,s.n do if not s.pending[i] then return true end end
  s.queue={}
  for i=1,s.n do
    local c=s.pending[i]; table.insert(s.queue,{player=i,card=c})
    for j,v in ipairs(s.hands[i]) do if v==c then table.remove(s.hands[i],j); break end end
  end
  table.sort(s.queue,function(a,b) return a.card<b.card end)
  s.phase='reveal'; s.cursor=1; note(s,'全员亮牌，按数字从小到大结算'); return true
end
function M.target(rows,card)
  local best,tail=0,0
  for r,row in ipairs(rows) do local c=row[#row]; if c<card and c>tail then best=r; tail=c end end
  return best
end
local function take(s,p,r,c)
  local pts=M.rowPoints(s.rows[r]); s.scores[p]=s.scores[p]+pts
  for _,x in ipairs(s.rows[r]) do table.insert(s.taken,x) end
  s.rows[r]={c}; note(s,'玩家 '..p..' 收走第 '..r..' 行，+'..pts..' 分')
end
function M.step(s)
  if s.phase~='reveal' and s.phase~='resolve' then return false,'wrong_phase' end
  s.phase='resolve'; s.revision=s.revision+1
  local item=s.queue[s.cursor]
  if not item then
    if s.round==10 then
      local over=s.mode=='quick'; for _,v in ipairs(s.scores) do if v>=66 then over=true end end
      if over then s.endReason=(s.mode=='quick') and 'rounds' or 'score' end
      s.phase=over and 'gameOver' or 'handEnd'; note(s,over and '对局结束：罚分最低者获胜' or '本手结束，继续累计罚分')
    else s.round=s.round+1; s.token=s.token+1; s.pending={}; s.queue={}; s.cursor=1; s.phase='select'; note(s,'第 '..s.round..' 轮：请选择一张牌') end
    return true
  end
  local r=M.target(s.rows,item.card)
  if r==0 then s.phase='chooseRow'; s.waiting=item.player; note(s,'玩家 '..item.player..' 的 '..item.card..' 太小，请选择任意一行收走'); return true end
  if #s.rows[r]==5 then take(s,item.player,r,item.card)
  else table.insert(s.rows[r],item.card); note(s,'玩家 '..item.player..'：'..item.card..' → 第 '..r..' 行') end
  s.cursor=s.cursor+1; return true
end
function M.choose(s,p,r,token)
  local ok,err=valid(s,p,token,'chooseRow'); if not ok then return false,err end
  if p~=s.waiting then return false,'not_your_choice' end
  if not integer(r) or r<1 or r>4 then return false,'invalid_row' end
  take(s,p,r,s.queue[s.cursor].card); s.cursor=s.cursor+1; s.waiting=0; s.phase='resolve'; s.revision=s.revision+1; return true
end
-- Client-driven early settlement (e.g. a wall-clock cap). Only allowed at a safe boundary.
function M.forceEnd(s,reason)
  if s.phase~='select' then return false,'wrong_phase' end
  s.phase='gameOver'; s.endReason=reason or 'time'; s.revision=s.revision+1
  note(s,'对局提前结算：'..(s.endReason=='time' and '已达用时上限' or '手动结束')); return true
end
-- Settlement vote passed: end the match now, from any phase, scores as they stand.
function M.settle(s,reason)
  if s.phase=='gameOver' then return false,'wrong_phase' end
  s.phase='gameOver'; s.endReason=reason or 'vote'; s.waiting=0; s.revision=s.revision+1
  note(s,'投票通过：对局提前结算'); return true
end
function M.nextHand(s)
  if s.phase~='handEnd' then return false,'wrong_phase' end
  deal(s); s.revision=s.revision+1; return true
end
function M.bestRow(rows)
  local best=1; for i=2,4 do if M.rowPoints(rows[i])<M.rowPoints(rows[best]) then best=i end end; return best
end
-- Heuristic receives only its own hand and the public board, never opponents' choices.
function M.bot(view)
  local best,cost=view.hand[1],math.huge
  for _,c in ipairs(view.hand) do
    local r=M.target(view.rows,c); local v
    if r==0 then v=M.rowPoints(view.rows[M.bestRow(view.rows)])+2
    elseif #view.rows[r]==5 then v=M.rowPoints(view.rows[r])+1
    else v=(c-view.rows[r][#view.rows[r]])/110 + #view.rows[r]*0.18 end
    if v<cost then best,cost=c,v end
  end
  return best
end
function M.timeout(s,token)
  if token~=s.token then return false,'stale_turn' end
  if s.phase=='select' then
    for p=1,s.n do if not s.pending[p] then M.submit(s,p,s.hands[p][1],token) end end
  elseif s.phase=='chooseRow' then M.choose(s,s.waiting,M.bestRow(s.rows),token)
  else return false,'wrong_phase' end
  return true
end
function M.view(s,p)
  assert(integer(p) and p>=1 and p<=s.n,'invalid_player')
  local ready,counts={},{ }; for i=1,s.n do ready[i]=s.pending[i]~=nil; counts[i]=#s.hands[i] end
  local revealed={}; if s.phase~='select' then revealed=copy(s.queue) end
  local winners={}; if s.phase=='gameOver' then local low=math.min(table.unpack(s.scores)); for i,x in ipairs(s.scores) do if x==low then table.insert(winners,i) end end end
  return {n=s.n,seat=p,mode=s.mode,handNo=s.handNo,round=s.round,token=s.token,revision=s.revision,phase=s.phase,hand=copy(s.hands[p]),rows=copy(s.rows),scores=copy(s.scores),ready=ready,counts=counts,queue=revealed,cursor=s.cursor,waiting=s.waiting,events=copy(s.events),winners=winners,endReason=s.endReason or ''}
end
function M.assertInvariant(s)
  local seen,count={},0
  local function add(c) assert(integer(c) and c>=1 and c<=104,'invalid card'); assert(not seen[c],'duplicate '..c); seen[c]=true; count=count+1 end
  for _,h in ipairs(s.hands) do for _,c in ipairs(h) do add(c) end end
  for _,row in ipairs(s.rows) do assert(#row>=1 and #row<=5); local last=0; for _,c in ipairs(row) do assert(c>last); last=c; add(c) end end
  for _,c in ipairs(s.taken) do add(c) end; for _,c in ipairs(s.undealt) do add(c) end
  if s.phase~='select' then for i=s.cursor,#s.queue do add(s.queue[i].card) end end
  assert(count==104,'card conservation '..count); return true
end
return M
