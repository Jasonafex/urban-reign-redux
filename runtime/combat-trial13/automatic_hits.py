"""Use native automatic action transitions to reset per-victim hit tracking."""
import struct,json
from ur_actions import ACTION

def split(ram,actions,reactions,hits,branches,manifest,ids,banks,clone,ac,chars,R,native_side=True):
 # The original first Lin Fong kick automatically goes into the second when
 # no extension is queued. Repeated input can enter Acid Storm after kick1.
 if native_side:
  first=ids['Violet','side'];second=clone('Violet','side-auto2',2046)
  actions[first*64:first*64+64]=ram[ACTION+2045*64:ACTION+(2045+1)*64]
  struct.pack_into('<h',actions,first*64+4,second)
  bi=len(branches)//30
  rows=[[ids['Violet',386],0,0,57,0,14,43,0,0,0,0,0,0,0,0],[-2,0,-10,57,14,14,0,0,0,0,0,0,0,0,0]]
  for row in rows:branches.extend(struct.pack('<15h',*row))
  struct.pack_into('<HH',actions,first*64+0x32,bi,2)
  m=next(m for m in manifest if m['id']==first);m['continuation']=rows;m['automatic_next']=second
  # A later press during the second kick can also continue the string.
  bi=len(branches)//30;rows=[[ids['Violet',386],0,0,57,16,44,43,0,0,0,0,0,0,0,0],[-2,0,-10,57,28,44,0,0,0,0,0,0,0,0,0]]
  for row in rows:branches.extend(struct.pack('<15h',*row))
  struct.pack_into('<HH',actions,second*64+0x32,bi,2);manifest[-1]['continuation']=rows
 # Multi-hit DR clips use one input but distinct native hit actions. Earlier
 # hits stagger; only the final hit applies the requested finishing reaction.
 stages=json.loads((R/'stages.json').read_text())
 for s in stages:
  if len(s['hits'])<2:continue
  first=ids[s['target'],s['key']];meta=next(m for m in manifest if m['id']==first)
  original=bytes(actions[first*64:(first+1)*64]);bank=next(b for c,k,b in banks if c==chars[s['target']] and k==0x10000+first)
  parts=[first]
  for j in range(1,len(s['hits'])):
   aid=clone(s['target'],s['key']+f'-auto{j+1}',2785);parts.append(aid)
   actions[aid*64:(aid+1)*64]=original;banks.append((chars[s['target']],0x10000+aid,bank))
   manifest[-1].update(label=s['label'],automatic_part=j+1)
  meta['automatic_actions']=parts
  for j,(aid,h) in enumerate(zip(parts,s['hits'])):
   template=2785 if j<len(parts)-1 else {'launch':1220,'knockback':2787}.get(s['finish'],2785)
   rec=bytearray.fromhex(ac[template]['reaction_raw']);ri=len(reactions)//236;hi=len(hits)//18
   limb_ends={'RH':(9,8),'LH':(13,12),'RF':(17,15),'LF':(21,19)}
   ends=[v for limb in h.get('collision_limbs',[h['limb']]) for v in limb_ends[limb]]
   ends=(ends+[-1]*4)[:4]
   hits.extend(struct.pack('<9h',*h['active'],h['damage'],h['height'],*ends,-1))
   struct.pack_into('<HHH',rec,0xc0,hi,1,h['height']);reactions.extend(rec)
   struct.pack_into('<H',actions,aid*64+0x38,ri)
   if j<len(parts)-1:
    start=s['hits'][j+1]['active'][0]-2
    struct.pack_into('<hhh',actions,aid*64+4,parts[j+1],start,start)
    struct.pack_into('<HH',actions,aid*64+0x32,0,0)
   next(m for m in manifest if m['id']==aid).update(actual_hit=h,automatic_next=parts[j+1] if j<len(parts)-1 else None)
