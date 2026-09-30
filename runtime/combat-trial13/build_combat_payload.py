from pathlib import Path
import json,sys,struct
R=Path(__file__).resolve().parent;T=R.parent
sys.path[:0]=[str(R),str(T)]
from combat_patch import build
from combat_routing import payload,BASE
chunks,hooks,banks=build()
rows=[r for r in json.loads((T/'revision6/manifest.json').read_text()) if r['character_id']!=77]
idle=[(r['character_id'],r['original_idle_id'],(T/'revision6'/f"{r['character']}.gyu").read_bytes()) for r in rows]
ground=T.parent/'repaired-exports-september29/Bryan'
grounded={p['motion']:(ground/p['new']).read_bytes() for p in json.loads((ground/'bank-patches.json').read_text()) if p['motion']<0x10000}
idle=[(c,k,grounded.get(k,b) if c==43 else b) for c,k,b in idle]
idle.append((46,1200,(R/'Kiryu-reference-idle.gyu').read_bytes()))
blob,rh=payload(idle+banks);hooks.update(rh);blob=bytearray(blob)
for addr,b in sorted(chunks):
 off=addr-BASE
 if off<len(blob):assert not any(blob[off:off+len(b)]),(hex(addr),len(b),len(blob))
 if off+len(b)>len(blob):blob.extend(bytes(off+len(b)-len(blob)))
 blob[off:off+len(b)]=b
(R/'combat-payload.bin').write_bytes(blob);(R/'combat-hooks.json').write_text(json.dumps(hooks,indent=2));print('Combat payload:',len(blob),'hooks:',len(hooks))
