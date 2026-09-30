"""September 29 follow-ups, applied after the established Trial 10 balance pass."""
from pathlib import Path
import json,struct,sys
import numpy as np
from scipy.spatial.transform import Rotation,Slerp
from build_idle_candidate import encode,parse_gyu,decode_track_samples

def apply(ram,actions,reactions,hits,branches,manifest,ids,banks,mapping,chars,clone,ac,R,spa_rows):
 meta={m['id']:m for m in manifest};bankmap={k-0x10000:b for c,k,b in banks if k>=0x10000}
 def rows(a):
  i,n=struct.unpack_from('<HH',actions,a*64+0x32)
  return [list(struct.unpack_from('<15h',branches,(i+j)*30)) for j in range(n)]
 def setrows(a,rr):
  i=len(branches)//30
  for row in rr:branches.extend(struct.pack('<15h',*row))
  struct.pack_into('<HH',actions,a*64+0x32,i,len(rr));meta[a]['continuation']=rr
 def walk(a):
  seen=[];todo=[a]
  while todo:
   x=todo.pop(0)
   if x<3950 or x in seen:continue
   seen.append(x);e=struct.unpack_from('<h',actions,x*64+4)[0]
   todo.extend([e] if e>=3950 else [z[0] for z in rows(x) if z[0]>=3950])
  return seen
 def root(n,d,a,b=-1):
  mapping[:]=[m for m in mapping if m[:3]!=(chars[n],d,b)];mapping.append((chars[n],d,b,a))
 paths={(n,d):walk(a) for c,d,b,a in mapping for n,ci in chars.items() if c==ci and (d!=0 or b==0)}
 oldpaths={str(k):v.copy() for k,v in paths.items()}
 # Grounded Bryan banks must precede any new timing/movement transform.
 ground=R.parents[1]/'repaired-exports-september29/Bryan'
 for p in json.loads((ground/'bank-patches.json').read_text()):
  aid=p['motion']-0x10000
  if aid in bankmap:
   assert bankmap[aid]==(ground/p['old']).read_bytes(),aid
   bankmap[aid]=(ground/p['new']).read_bytes()
 # Native lead-ins require their actual native motion, not a DR stand-in.
 sys.path.insert(0,str(R.parent/'revision3'))
 from prepare import native_bank
 kr=(R.parent/'revision10/runtime/T10-Kazuya/eeMemory.bin').read_bytes()
 for aid in paths['Kazuya',0][:3]+[paths['Kazuya',1][-1]]:
  motion=struct.unpack_from('<H',actions,aid*64)[0]
  bankmap[aid]=encode(native_bank(kr,motion)[1])[0]
  fi=struct.unpack_from('<I',actions,aid*64+0x28)[0];fn=struct.unpack_from('<H',actions,aid*64+0x30)[0]
  flags=[struct.unpack_from('<H',ram,0x4a5120+(fi+j)*2)[0] for j in range(fn)]
  assert set(flags)<={0,3},(aid,flags)
  # Native late-recovery flags 1/2 allow a fresh attack or movement before
  # the end frame. Custom continuations use their explicitly retimed rows.
  struct.pack_into('<II',actions,aid*64+0x28,0,0);struct.pack_into('<H',actions,aid*64+0x30,0)
  if not any(k==0x10000+aid for c,k,b in banks):banks.append((16,0x10000+aid,bankmap[aid]))
 # Restore the native Kadonashi running kick, including its own animation bank.
 running=clone('Kazuya','Kadonashi running jumping kick',1694);meta[running]=manifest[-1]
 bankmap[running]=(R/'Kadonashi-running-native.gyu').read_bytes()
 banks.append((16,0x10000+running,bankmap[running]));root('Kazuya',0,running,3)
 # Native yellow armor is reaction parameter 1 (verified using action 2713).
 # Keep each character's activation animation, event list, cost and duration.
 buff=[]
 for n,native in [('Kazuya',2712),('Bryan',2007)]:
  aid=clone(n,'Yellow super armor',native);meta[aid]=manifest[-1]
  ri=len(reactions)//236;rec=bytearray.fromhex(ac[native]['reaction_raw'])
  struct.pack_into('<H',rec,0xe4,1);reactions.extend(rec);struct.pack_into('<H',actions,aid*64+0x38,ri)
  spa_rows.append((chars[n],2,-1,aid));meta[aid].update(buff='yellow super armor',native_buff_template=2713)
  buff.append(dict(character=n,action=aid,native=native,parameter=1))
 # Bryan: swap the roots first. The four removed hits remain unreachable.
 newneutral=paths['Bryan',3][4:];newup=paths['Bryan',0];newside=paths['Bryan',1]
 root('Bryan',0,newneutral[0],0);root('Bryan',1,newup[0]);root('Bryan',3,newside[0])
 def private(a,kind=None):
  ri=struct.unpack_from('<H',actions,a*64+0x38)[0];old=reactions[ri*236:(ri+1)*236]
  hi,hn=struct.unpack_from('<HH',old,0xc0);newhi=len(hits)//18
  hits.extend(hits[hi*18:(hi+hn)*18]);rec=bytearray(old)
  if kind:
   template={'medium':2786,'heavy':1472,'launch':1494}[kind]
   rec=bytearray.fromhex(ac[template]['reaction_raw']);rec[0xc0:0xc6]=old[0xc0:0xc6]
   for h in range(newhi,newhi+hn):
    damage=struct.unpack_from('<h',hits,h*18+4)[0]
    struct.pack_into('<h',hits,h*18+4,max(damage,{'medium':30,'heavy':45,'launch':35}[kind]))
   meta[a]['hit_class']=kind
  struct.pack_into('<H',rec,0xc0,newhi);newri=len(reactions)//236;reactions.extend(rec)
  struct.pack_into('<H',actions,a*64+0x38,newri)
  return list(range(newhi,newhi+hn))
 private(paths['Kazuya',1][0],'launch');private(paths['Kazuya',1][-1],'heavy')
 for a in paths['Kazuya',3][:-1]:private(a,'medium')
 private(paths['Kazuya',3][-1],'heavy')
 # Duration multipliers are explicit: half-speed = 2x animation duration.
 specs={}
 def spec(a,**kw):specs.setdefault(a,dict(speed=1.,recovery=1.,travel=1.,tail=0)).update(kw)
 spec(paths['Kazuya',2][0],recovery=.5)
 for a in paths['Kazuya',0][:4]:spec(a,recovery=.7)
 spec(paths['Kazuya',1][-1],speed=.5)
 for a in paths['Kazuya',3]:spec(a,speed=.5)
 for a in newneutral:spec(a,speed=.65,travel=1.35)
 spec(newneutral[-1],tail=6)
 spec(newup[1],speed=.5);spec(newup[-1],speed=.6)
 for a in newside[:2]:spec(a,speed=.5)
 audit=[]
 # Independent copies prevent identical clips used in different strings from
 # accidentally inheriting each other's speed. Destination frames are remapped below.
 maps={};before_rows={a:rows(a) for a in specs};before_next={a:struct.unpack_from('<hh',actions,a*64+4) for a in specs}
 for a,s in specs.items():
  hh=private(a);blob=bankmap[a];p=parse_gyu(blob)
  v=np.stack([decode_track_samples(blob,t) for t in p['records'][0]['tracks']],axis=1)
  assert v.shape[1:]==(21,3)
  last=max(struct.unpack_from('<h',hits,h*18+2)[0] for h in hh)
  duration=1/s['speed'];recover=s['recovery']
  def tm(t,last=last,duration=duration,recover=recover):return int(round((min(t,last)+max(0,t-last)*recover)*duration))
  maps[a]=tm;oldend=len(v)-1;end=tm(oldend)
  sample=np.interp(np.arange(end+1),[0,tm(last),end],[0,last,oldend])
  out=np.empty((end+1,21,3));out[:,0]=np.array([np.interp(sample,np.arange(len(v)),v[:,0,k]) for k in range(3)]).T;out[:,1]=0
  for ch in range(2,21):out[:,ch]=Slerp(np.arange(len(v)),Rotation.from_euler('xyz',v[:,ch]*2*np.pi))(sample).as_euler('xyz')/(2*np.pi)
  out[:,0,[0,2]]=out[0,0,[0,2]]+(out[:,0,[0,2]]-out[0,0,[0,2]])*s['travel']
  if s['tail']:out=np.concatenate([out,np.repeat(out[-1:],s['tail'],axis=0)])
  bankmap[a],error=encode(out)
  for h in hh:
   x,y=struct.unpack_from('<hh',hits,h*18);struct.pack_into('<hh',hits,h*18,tm(x),tm(y))
  oldaf=struct.unpack_from('<h',actions,a*64+8)[0];struct.pack_into('<h',actions,a*64+8,tm(oldaf))
  rr=before_rows[a]
  for row in rr:row[4]=tm(row[4]);row[5]=tm(row[5])
  setrows(a,rr)
  if before_next[a][0]<3950 and not any(row[0]>=3950 for row in rr):
   struct.pack_into('<h',actions,a*64+8,len(out)-1);meta[a]['full_final_recovery']=True
  meta[a]['september29_timing']=s;meta[a]['encoded_frames']=len(out)
  audit.append(dict(action=a,character=meta[a]['character'],old_frames=len(v),frames=len(out),**s,codec_error=error))
 # +6 is the frame to enter the destination action at; it is not a frame in
 # the outgoing action. Split-contact transitions therefore use the next map.
 for a in meta:
  dest,frame=struct.unpack_from('<hh',actions,a*64+4)
  if dest in maps and dest>=3950:struct.pack_into('<h',actions,a*64+6,maps[dest](frame))
 paths={(n,d):walk(a) for c,d,b,a in mapping for n,ci in chars.items() if c==ci and (d!=0 or b==0)}
 full_recovery=[]
 for a in sorted(set(x for chain in paths.values() for x in chain)):
  if a not in bankmap:continue
  if struct.unpack_from('<h',actions,a*64+4)[0]>=3950 or any(row[0]>=3950 for row in rows(a)):continue
  parsed=parse_gyu(bankmap[a]);end=parsed['records'][0]['frame_count']-1
  struct.pack_into('<h',actions,a*64+8,end);meta[a]['full_final_recovery']=True;full_recovery.append(a)
 banks[:]=[(c,k,bankmap.get(k-0x10000,b)) for c,k,b in banks]
 assert paths['Bryan',0]==newneutral and paths['Bryan',1]==newup and paths['Bryan',3]==newside
 assert not set(oldpaths[str(('Bryan',3))][:4])&set(newneutral)
 (R/'followup-report.json').write_text(json.dumps(dict(paths_before=oldpaths,paths={f'{n}/{d}':v for (n,d),v in paths.items()},retiming=audit,buffs=buff,running_kick=running,full_recovery=full_recovery,runtime_verified=False),indent=2))


