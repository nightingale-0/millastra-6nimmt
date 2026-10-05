-- Versioned, bounded snapshot format; fixed numeric fields and trusted enum strings.
local W={}
local function split(s,sep) local out={}; for v in (s..sep):gmatch('(.-)'..sep) do out[#out+1]=v end; return out end
local function nums(s) local out={}; for n in s:gmatch('[^,]+') do out[#out+1]=tonumber(n) end; return out end
function W.encode(v)
  local rows,ready,q={},{},{}
  for i,r in ipairs(v.rows) do rows[i]=table.concat(r,',') end
  for i,b in ipairs(v.ready) do ready[i]=b and 1 or 0 end
  for i,c in ipairs(v.queue) do q[i]=c.player..','..c.card end
  return table.concat({'N1',v.n,v.seat,v.mode,v.handNo,v.round,v.token,v.revision,v.phase,table.concat(v.hand,','),table.concat(rows,';'),table.concat(v.scores,','),table.concat(ready,','),table.concat(v.counts,','),table.concat(q,';'),v.cursor,v.waiting,table.concat(v.events,'~'),table.concat(v.winners,',')},'|')
end
function W.decode(s)
  assert(type(s)=='string' and #s<16000,'invalid snapshot')
  local t=split(s,'|'); assert(#t==19 and t[1]=='N1','snapshot version')
  local rows,q,ready={},{},{}
  for _,x in ipairs(split(t[11],';')) do rows[#rows+1]=nums(x) end
  if t[15]~='' then for _,x in ipairs(split(t[15],';')) do local a=nums(x); q[#q+1]={player=a[1],card=a[2]} end end
  for i,x in ipairs(nums(t[13])) do ready[i]=x==1 end
  return {n=tonumber(t[2]),seat=tonumber(t[3]),mode=t[4],handNo=tonumber(t[5]),round=tonumber(t[6]),token=tonumber(t[7]),revision=tonumber(t[8]),phase=t[9],hand=nums(t[10]),rows=rows,scores=nums(t[12]),ready=ready,counts=nums(t[14]),queue=q,cursor=tonumber(t[16]),waiting=tonumber(t[17]),events=split(t[18],'~'),winners=nums(t[19])}
end
return W
