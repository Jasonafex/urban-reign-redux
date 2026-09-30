import json,struct
from ur_actions import ACTION

def append_actions(ram,actions,reactions,hits,branches,manifest,ids,banks,mapping,chars,clone,ac,R):
 stages=json.loads((R/'stages.json').read_text())
 ends={'RH':(9,8),'LH':(13,12),'RF':(17,15),'LF':(21,19)}
 # Choose native stagger, knockback, or launch reactions explicitly.
 for s in stages:
  template={'launch':1220,'knockback':2787}.get(s['finish'],2785)
  aid=clone(s['target'],s['key'],template)
  rec=bytearray.fromhex(ac[template]['reaction_raw']);ri=len(reactions)//236;hi=len(hits)//18
  for h in s['hits']:
   endpoints=[v for limb in h.get('collision_limbs',[h['limb']]) for v in ends[limb]]
   endpoints=(endpoints+[-1]*4)[:4]
   hits.extend(struct.pack('<9h',*h['active'],h['damage'],h['height'],*endpoints,-1))
  struct.pack_into('<HHH',rec,0xc0,hi,len(s['hits']),s['hits'][0]['height']);reactions.extend(rec)
  struct.pack_into('<h',actions,aid*64,0);struct.pack_into('<hh',actions,aid*64+6,0,s['frames']-1)
  struct.pack_into('<H',actions,aid*64+0x38,ri)
  for off in [0x28,0x2c]:struct.pack_into('<I',actions,aid*64+off,0)
  struct.pack_into('<H',actions,aid*64+0x30,0);struct.pack_into('<HH',actions,aid*64+0x3c,0,0)
  banks.append((chars[s['target']],0x10000+aid,(R/'attack-retargets'/f"{s['key']}.gyu").read_bytes()))
  manifest[-1].update(label=s['label'],source=s['source'],source_ids=s['source_ids'],source_start=s['start'],
                      hits=s['hits'],recovery=s['frames']-1,finish=s['finish'],next=s['next'])
 for s in stages:
  if not s['next']:continue
  aid=ids[s['target'],s['key']];dest=ids[s['target'],s['next']]
  last=max(h['active'][1] for h in s['hits']);commit=last+1;end=min(s['frames']-2,commit+13)
  assert end>=commit,(s['key'],commit,end)
  rows=[[dest,0,0,57,1,end,43,0,0,0,0,0,0,0,0],[-2,0,-10,57,commit,end,0,0,0,0,0,0,0,0,0]]
  bi=len(branches)//30
  for row in rows:branches.extend(struct.pack('<15h',*row))
  struct.pack_into('<HH',actions,aid*64+0x32,bi,len(rows))
  next(m for m in manifest if m['id']==aid)['continuation']=rows
 request=json.loads((R/'request.json').read_text())
 for c in request['chains']:
  name=c['character'];direction={'neutral':0,'up':1,'down':2,'side':3}[c['direction']]
  mapping.append((chars[name],direction,0 if direction==0 else -1,ids[name,c['stages'][0]]))
