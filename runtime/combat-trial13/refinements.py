"""Trial 9 additions retain Trial 8 IDs, native records and special attacks."""
import json,struct
from extra_actions import append_actions

def apply(ram,actions,reactions,hits,branches,manifest,ids,banks,mapping,chars,clone,ac,R):
 def record(aid):return next(m for m in manifest if m['id']==aid)
 def link(aid,dest,lag=8):
  m=record(aid);ri=struct.unpack_from('<H',actions,aid*64+0x38)[0]
  hi,hn=struct.unpack_from('<HH',reactions,ri*236+0xc0)
  last=max(struct.unpack_from('<h',hits,(hi+i)*18+2)[0] for i in range(hn))
  end=struct.unpack_from('<h',actions,aid*64+8)[0]-1
  commit=min(last+lag,end);assert commit>last,(aid,last,end)
  rows=[[dest,0,0,57,1,end,43,0,0,0,0,0,0,0,0],[-2,0,-10,57,commit,end,0,0,0,0,0,0,0,0,0]]
  bi=len(branches)//30
  for row in rows:branches.extend(struct.pack('<15h',*row))
  struct.pack_into('<HH',actions,aid*64+0x32,bi,2);m['continuation']=rows;m['minimum_post_contact_frames']=commit-last
 def root(char,direction,bearing,aid):
  mapping[:]=[m for m in mapping if m[:3]!=(char,direction,bearing)]
  mapping.append((char,direction,bearing,aid))
 # Addition directions are preparation labels; route explicitly below.
 unused=[]
 append_actions(ram,actions,reactions,hits,branches,manifest,ids,banks,unused,chars,clone,ac,R/'additions')
 get=lambda n,k:ids[n,k]
 root(16,3,-1,get('Kazuya','Kazuya-side-01'))
 root(16,0,3,get('Kazuya','Kazuya-down-01'))
 link(get('Kazuya',439),get('Kazuya','Kazuya-neutral-01'))
 # Native Reggie high right roundhouse, not the low launch kick 1220.
 aid=get('Kazuya','roundhouse');actions[aid*64:(aid+1)*64]=bytes.fromhex(ac[1471]['raw'])
 struct.pack_into('<hh',actions,aid*64+4,-2,0);struct.pack_into('<HH',actions,aid*64+0x32,0,0)
 record(aid).update(native_template=1471,label='Reggie high right roundhouse')
 # Keep the existing SPA action ID, cost, flags and damage; replace its bank
 # and active window with the complete two-spin source animation.
 spa=get('Kazuya',428);new=get('Kazuya','Kazuya-up-01')
 bank=(R/'spa-contact-adjusted.gyu').read_bytes()
 banks[:]=[(c,k,bank if k==0x10000+spa else b) for c,k,b in banks]
 struct.pack_into('<h',actions,spa*64+8,106)
 ri=struct.unpack_from('<H',actions,spa*64+0x38)[0];hi=struct.unpack_from('<H',reactions,ri*236+0xc0)[0]
 struct.pack_into('<hh',hits,hi*18,63,64)
 record(spa).update(source_move='Kz_kazup00E',source_ids=[454],active=[63,64],recovery=106,source_frames=117,horizontal_travel_scale=.50)
 # Lin Fong's two native punches lead into all four imported strikes.
 link(get('Violet','native2'),get('Violet','Violet-neutral-01'))
 up=clone('Violet','Native up into Rainbow Kick',2422)
 root(54,1,-1,up);link(up,get('Violet','Violet-up-01'))
 # Jin's actual base style10 has three default inputs1719/1720/1721.
 # Retain its first punch; replace the final two with all three Evil Intent.
 j1=clone('Jin','Kadonashi neutral first',1719)
 root(15,0,0,j1);link(j1,get('Jin','Jin-neutral-01'))
 # Include the approach to contact: fast retargeted hands can traverse an
 # entire victim capsule between adjacent poses, especially rising punches.
 edited=set()
 for m in manifest:
  if not any(k in m for k in ['source_move','hits','actual_hit']):continue
  if 'victim_action' in m or 'paired_attacker' in m:continue
  ri=struct.unpack_from('<H',actions,m['id']*64+0x38)[0]
  hi,hn=struct.unpack_from('<HH',reactions,ri*236+0xc0)
  windows=[]
  for i in range(hi,hi+hn):
   if i not in edited:
    a,b=struct.unpack_from('<hh',hits,i*18)
    struct.pack_into('<hh',hits,i*18,max(0,a-2),b+1);edited.add(i)
   windows.append(list(struct.unpack_from('<hh',hits,i*18)))
  m['adapted_active_windows']=windows
 # Recovery applies to user-input transitions, never automatic second hits.
 for m in manifest:
  bi,bn=struct.unpack_from('<HH',actions,m['id']*64+0x32)
  rows=[list(struct.unpack_from('<15h',branches,(bi+i)*30)) for i in range(bn)]
  if len(rows)!=2 or rows[0][6]!=43 or rows[1][2]!=-10:continue
  if 'source_ids' in m or 'source_move' in m or 'automatic_part' in m:
   if m['character'] in ['Kiryu','Cammy','Hwoarang','Leon','Jack5','Jin','Kazuya','Violet','Bryan','Dragunov']:
    link(m['id'],rows[0][0],8)
 # Gatling's fourth hit must stagger; preserve its own collision and damage.
 aid=get('Kiryu','Kiryu-neutral-04');ri=struct.unpack_from('<H',actions,aid*64+0x38)[0]
 rec=bytearray.fromhex(ac[2785]['reaction_raw']);rec[0xc0:0xc6]=reactions[ri*236+0xc0:ri*236+0xc6]
 reactions[ri*236:(ri+1)*236]=rec;record(aid)['finish']='stagger'
 # Rocket Uppercut uses the native high uppercut launch reaction instead of
 # the low kick flip, retaining its own collision window and damage.
 aid=get('Jack5','Jack5-side-03');ri=struct.unpack_from('<H',actions,aid*64+0x38)[0]
 rec=bytes.fromhex(ac[2001]['reaction_raw'])
 reactions[ri*236:ri*236+16]=rec[:16];record(aid)['launch_reaction']=[152,156]
 return link
