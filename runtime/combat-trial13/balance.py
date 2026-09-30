"""Trial 10: explicit chain routing, native reaction classes and synchronized retiming."""
import json,struct,hashlib
import numpy as np
from scipy.spatial.transform import Rotation,Slerp
from extra_actions import append_actions
from automatic_hits import split
from build_idle_candidate import encode,parse_gyu,decode_track_samples

def apply(ram,actions,reactions,hits,branches,manifest,ids,banks,mapping,chars,clone,ac,R,link):
 get=lambda n,k:ids[n,k]
 def meta(a):return next(m for m in manifest if m['id']==a)
 def root(n,d,a,b=-1):
  mapping[:]=[m for m in mapping if m[:3]!=(chars[n],d,b)];mapping.append((chars[n],d,b,a))
 def hr(a):
  ri=struct.unpack_from('<H',actions,a*64+0x38)[0];hi,hn=struct.unpack_from('<HH',reactions,ri*236+0xc0)
  return ri,list(range(hi,hi+hn))
 def rows(a):
  bi,bn=struct.unpack_from('<HH',actions,a*64+0x32)
  return [list(struct.unpack_from('<15h',branches,(bi+i)*30)) for i in range(bn)]
 def setrows(a,rr):
  bi=len(branches)//30
  for row in rr:branches.extend(struct.pack('<15h',*row))
  struct.pack_into('<HH',actions,a*64+0x32,bi,len(rr));meta(a)['continuation']=rr
 def stop(a):struct.pack_into('<hh',actions,a*64+4,-2,0);setrows(a,[])
 def walk(a):
  seen=[];pending=[a]
  while pending:
   x=pending.pop(0)
   if x<3950 or x in seen:continue
   seen.append(x)
   e=struct.unpack_from('<h',actions,x*64+4)[0]
   nxt=[e] if e>=3950 else [r[0] for r in rows(x) if r[0]>=3950]
   pending.extend(nxt)
  return seen
 def terminal(a):
  return struct.unpack_from('<h',actions,a*64+4)[0]<3950 and not any(r[0]>=3950 for r in rows(a))
 append_actions(ram,actions,reactions,hits,branches,manifest,ids,banks,[],chars,clone,ac,R/'new-additions')
 split(ram,actions,reactions,hits,branches,manifest,ids,banks,clone,ac,chars,R/'new-additions',native_side=False)
 for n,d in [('Kazuya',3),('Hwoarang',3),('Leon',0),('Leon',3)]:
  key=f"T10-{n}-{'neutral' if d==0 else 'side'}-01";root(n,d,get(n,key),0 if d==0 else -1)
 j1=next(a for c,d,b,a in mapping if (c,d,b)==(15,0,0));j2=clone('Jin','Kadonashi neutral second',1720)
 link(j1,j2);link(j2,get('Jin','Jin-neutral-01'))
 # Firecracker alone is the two-hit down string.
 stop(get('Hwoarang','Hwoarang-down-02'))
 # Short native roots are retained; all altered reactions get private records,
 # including native-cloned roundhouse/openers, so no shared native data changes.
 private={}
 def reaction(a,kind,damage=None):
  ri,hh=hr(a);old=bytes(reactions[ri*236:(ri+1)*236]);newhi=len(hits)//18
  for h in hh:hits.extend(hits[h*18:(h+1)*18])
  templates={'light':2785,'medium':2786,'heavy':1472,'launch':1494,'sweep':1220,'corkscrew':1544}
  rec=bytearray.fromhex(ac[templates[kind]]['reaction_raw']);rec[0xc0:0xc6]=old[0xc0:0xc6]
  struct.pack_into('<H',rec,0xc0,newhi);newri=len(reactions)//236;reactions.extend(rec);struct.pack_into('<H',actions,a*64+0x38,newri)
  for h in range(newhi,newhi+len(hh)):
   val=struct.unpack_from('<h',hits,h*18+4)[0]
   floor={'light':20,'medium':30,'launch':35,'heavy':45,'sweep':40,'corkscrew':35}[kind]
   struct.pack_into('<h',hits,h*18+4,int(damage if damage is not None else max(val,floor)))
  meta(a).update(hit_class=kind,reaction_template=templates[kind],damage=[struct.unpack_from('<h',hits,h*18+4)[0] for h in range(newhi,newhi+len(hh))])
  private[a]=newri
 paths={(n,d):walk(a) for c,d,b,a in mapping for n,ci in chars.items() if ci==c and (d!=0 or b==0)}
 specials=[];spaaids=set();spaaudit=[]
 for n,label,group,native,nativechain in [
  ('Leon','up',1,1905,[1905]),('Leon','down',3,1372,[1372,1373,1368,1369,1370,1371,1364,1365,1366,1367]),
  ('Dragunov','up',1,2775,[2775]),('Dragunov','down',3,2922,[2922,2923,2924,2920,2921])]:
  first=get(n,f'T10-{n}-{label}-01');chain=walk(first);spaaids.update(chain);specials.append((chars[n],group,-1,first))
  total=sum(h[2] for x in nativechain for h in ac[x]['hits']);cost=struct.unpack_from('<I',bytes.fromhex(ac[native]['raw']),16)[0]
  weights=[sum(struct.unpack_from('<h',hits,h*18+4)[0] for h in hr(a)[1]) for a in chain];dmg=[int(round(total*w/sum(weights))) for w in weights];dmg[-1]+=total-sum(dmg)
  for i,a in enumerate(chain):
   struct.pack_into('<II',actions,a*64+12,1,cost if i==0 else 0)
   reaction(a,'heavy' if i==len(chain)-1 else ('launch' if n=='Leon' and group==3 and i==len(chain)-2 else 'medium'),dmg[i])
   # Native SPA2 transitions are automatic (no input condition), retaining
   # the actor's native SPA playback multiplier through the SPA action flag.
   if i+1<len(chain):
    last=max(struct.unpack_from('<h',hits,h*18+2)[0] for h in hr(a)[1]);at=last+1
    setrows(a,[[chain[i+1],0,-10,57,at,at,0,0,0,0,0,0,0,0,0]])
   meta(a).update(spa=True,native_spa=native,spa_cost=cost if i==0 else 0)
  spaaudit.append(dict(character=n,group=group,actions=chain,native_actions=nativechain,total_damage=total,damage=dmg,cost=cost,native_spa_flag=True))
 # Classify every reachable imported hit; retain the character's native lead-in.
 for (n,d),chain in paths.items():
  for i,a in enumerate(chain):
   m=meta(a);imported=any(k in m for k in ['source_ids','source_move','actual_hit','automatic_part'])
   if not imported:continue
   finish=m.get('finish');kind='launch' if finish=='launch' else 'heavy' if finish=='knockback' else 'light'
   if terminal(a) and kind=='light':kind='heavy'
   if n in ['Cammy','Kiryu'] and 0<i<len(chain)-1:kind='medium'
   if n=='Bryan' and len(chain)-3<=i<len(chain)-1:kind='medium'
   reaction(a,kind)
 def classify(n,d,index,kind):reaction(paths[n,d][index],kind)
 classify('Kazuya',3,2,'launch');classify('Kazuya',1,-1,'heavy')
 running=get('Kazuya','Kazuya-down-01');reaction(running,'heavy')
 classify('Jin',0,-1,'heavy');classify('Jin',3,-1,'heavy')
 for d in [0,1,2]:classify('Violet',d,-1,'heavy')
 # Violet's down input has quick and delayed branches. Both terminal kicks
 # need the requested heavy finisher; a breadth-first list has only one last.
 for a in paths['Violet',2]:
  if terminal(a):reaction(a,'heavy')
 for a in paths['Violet',0][2:-1]:reaction(a,'light')
 for a in paths['Jack5',0][:-1]:reaction(a,'light')
 classify('Jack5',0,-1,'heavy');classify('Jack5',3,-1,'launch')
 classify('Hwoarang',2,-1,'launch')
 classify('Dragunov',3,-2,'launch');classify('Dragunov',3,-1,'heavy')
 classify('Bryan',1,-1,'launch')
 for d in [0,3]:classify('Bryan',d,-1,'heavy')
 classify('Cammy',2,-1,'sweep');classify('Cammy',3,-1,'launch');classify('Cammy',0,-1,'heavy')
 cup=paths['Cammy',1]
 for a in cup[:2]:reaction(a,'medium')
 # Locate the actual Bow & Arrow sweep by its low collision level, not a
 # guessed ordinal: this chain includes a split two-punch input.
 lows=[a for a in cup[:-1] if any(struct.unpack_from('<h',hits,h*18+6)[0]==2 for h in hr(a)[1])]
 reaction(lows[-1] if lows else cup[-2],'corkscrew');reaction(cup[-1],'heavy')
 for d in [0,1,3]:classify('Kiryu',d,-1,'heavy')
 classify('Leon',0,2,'medium');classify('Leon',0,3,'medium');classify('Leon',0,-1,'heavy')
 classify('Leon',3,0,'medium');classify('Leon',3,-2,'launch');classify('Leon',3,-1,'heavy')
 # Decode each bank once. Automatic sub-actions share a common time base;
 # retime all their collision windows and transition frame indices together.
 bankmap={k-0x10000:b for c,k,b in banks if k>=0x10000}
 active=set(a for chain in paths.values() for a in chain)|spaaids|{running,get('Kazuya',428)}
 done=set();reports=[]
 for aid in sorted(active):
  if aid in done or aid not in bankmap:continue
  m=meta(aid);n=m['character'];blob=bankmap[aid]
  group=[a for a in active if a not in done and a in bankmap and bankmap[a]==blob and meta(a)['character']==n]
  done.update(group)
  directions=[d for (name,d),chain in paths.items() if name==n and aid in chain];d=directions[0] if directions else None
  rr={a:rows(a) for a in group};oldhr={a:hr(a)[1] for a in group}
  starts=[struct.unpack_from('<h',hits,h*18)[0] for a in group for h in oldhr[a]]
  lasts=[struct.unpack_from('<h',hits,h*18+2)[0] for a in group for h in oldhr[a]]
  onset=min(starts);last=max(lasts);startup=1.;recover=1.;travel=1.;height=1.
  if aid not in spaaids:
   recover={'Hwoarang':.6,'Dragunov':.7,'Bryan':.7,'Cammy':.6}.get(n,1.)
   if n=='Cammy':startup=1.5
   if (n,d)==('Jin',3):recover=.35
   if (n,d)==('Violet',3):recover=.3
   if (n,d)==('Violet',2) and terminal(aid):recover=.6
   if n=='Jack5':
    travel=2.
    if d==0 and aid in paths[n,d][:4]:recover=.5
   if (n,d)==('Bryan',3) and aid in paths[n,d][:5]:recover=.125
   if (n,d)==('Bryan',1) and aid==paths[n,d][0]:startup=1.5
   if (n,d)==('Kiryu',1) and aid==paths[n,d][1]:startup=1.7
   if (n,d)==('Hwoarang',1):travel=2.;height=1.5
   if (n,d)==('Violet',1):travel=3.
   if aid in [running,get('Kazuya',428)]:travel=2.5
   if aid==running:height=2.5
  parsed=parse_gyu(blob);val=np.stack([decode_track_samples(blob,t) for t in parsed['records'][0]['tracks']],axis=1)
  val[:,0,[0,2]]=val[0,0,[0,2]]+(val[:,0,[0,2]]-val[0,0,[0,2]])*travel
  val[:,0,1]=val[0,0,1]+(val[:,0,1]-val[0,0,1])*height
  if n=='Leon' and aid==get('Leon','T10-Leon-up-01'):
   # A modest one-metre lunge is accumulated through the source windup.
   val[:,0,2]+=np.minimum(np.arange(len(val))/max(onset,1),1.)*1.0
  def tm(t):return int(round(t*startup if t<=onset else onset*startup+(t-onset) if t<=last else onset*startup+(last-onset)+(t-last)*recover))
  end=len(val)-1;nt=tm(end);oldpoints=np.array([0,onset,last,end],float);newpoints=np.array([tm(x) for x in oldpoints],float)
  good=np.r_[True,np.diff(newpoints)>0];sample=np.interp(np.arange(nt+1),newpoints[good],oldpoints[good])
  out=np.empty((nt+1,21,3));out[:,0]=np.array([np.interp(sample,np.arange(len(val)),val[:,0,k]) for k in range(3)]).T;out[:,1]=0
  for ch in range(2,21):out[:,ch]=Slerp(np.arange(len(val)),Rotation.from_euler('xyz',val[:,ch]*2*np.pi))(sample).as_euler('xyz')/(2*np.pi)
  newblob,err=encode(out)
  for a in group:
   bankmap[a]=newblob
   for h in oldhr[a]:
    x,y=struct.unpack_from('<hh',hits,h*18);struct.pack_into('<hh',hits,h*18,tm(x),tm(y))
   e,st,af=struct.unpack_from('<hhh',actions,a*64+4);struct.pack_into('<hh',actions,a*64+6,tm(st),tm(af))
   transformed=[]
   for row in rr[a]:
    row=row.copy();row[4]=tm(row[4]);row[5]=tm(row[5])
    # Destination starting frames belong to the next bank, not this one.
    transformed.append(row)
   setrows(a,transformed)
   meta(a).update(retiming=dict(startup=startup,recovery=recover),movement=dict(forward=travel,jump=height),encoded_frames=len(out))
  reports.append(dict(actions=group,character=n,direction=d,source_frames=len(val),frames=len(out),startup=startup,recovery=recover,travel=travel,height=height,error=err))
 # Rainbow Kick stays active from the rising kick through landing. A single
 # action/hit record retains the engine's one-hit-per-victim tracking.
 rain=get('Violet','Violet-up-01');ri,hh=hr(rain);assert len(hh)==1
 blob=bankmap[rain];p=parse_gyu(blob);v=np.stack([decode_track_samples(blob,t) for t in p['records'][0]['tracks']],axis=1)
 oldstart,oldend=struct.unpack_from('<hh',hits,hh[0]*18);ys=v[:,0,1];peak=int(np.argmax(ys));ground=ys[-1];landing=next((i for i in range(max(peak,oldend),len(ys)) if ys[i]<=ground+.015),len(ys)-2)
 struct.pack_into('<hh',hits,hh[0]*18,max(1,oldstart-10),min(len(v)-2,max(oldend,landing)))
 meta(rain).update(single_hit=True,active_through_landing=True)
 banks[:]=[(c,k,bankmap.get(k-0x10000,b)) for c,k,b in banks]
 # Record the real reachable sequences for validation, including split hits.
 paths={(n,d):walk(a) for c,d,b,a in mapping for n,ci in chars.items() if ci==c and (d!=0 or b==0)}
 assert [meta(a)['native_template'] for a in paths['Jin',0][:2]]==[1719,1720]
 assert len(paths['Jin',0])==5
 assert len(paths['Hwoarang',2])==2
 assert not any(c==54 for c,g,b,a in specials)
 (R/'balance-report.json').write_text(json.dumps(dict(paths={f'{n}/{d}':v for (n,d),v in paths.items()},retiming=reports,spas=spaaudit,runtime_validated=False),indent=2))
 return specials
