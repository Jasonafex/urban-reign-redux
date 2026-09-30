"""Build the combat executable and verified Jack jaw repairs into a candidate."""
from pathlib import Path
import sys,json,struct,hashlib,shutil
R=Path(__file__).resolve().parent;ROOT=R.parents[2]
sys.path.insert(0,str(ROOT/'work/expansion-research'))
from build_registered_resources import directory_records
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(16*1024*1024),b''):h.update(b)
 return h.hexdigest()
source=ROOT/'Deliverables/Tekken Moves Trial 10 - September 29/Urban Reign Redux - Glasses Stability.iso'
expected='db7092aa7722afb85ec90e98c3bdd6d61a46586b923257f149f648ce34c9b405'
assert sha(source)==expected
with source.open('rb') as f:
 records=directory_records(f);entry=records['SLUS_212.09;1'][1]
 pos=struct.unpack_from('<I',entry,2)[0]*2048;size=struct.unpack_from('<I',entry,10)[0];f.seek(pos);elf=bytearray(f.read(size))
original=bytes(elf)
def off(a):
 ph=struct.unpack_from('<I',elf,28)[0]
 for i in range(struct.unpack_from('<H',elf,44)[0]):
  t,o,v,_,n=struct.unpack_from('<5I',elf,ph+32*i)
  if t==1 and v<=a<v+n:return o+a-v
 raise ValueError(hex(a))
blob=(R/'combat-payload.bin').read_bytes();start=off(0x20b0000);assert start+len(blob)<=len(elf)
elf[start:start+len(blob)]=blob
hooks=json.loads((R/'combat-hooks.json').read_text())
oldhooks=json.loads((R.parent/'revision10/combat-hooks.json').read_text())
for k,(old,new) in hooks.items():
 a=int(k)
 if a==0x2a24f8:
  # The installed electricity wrapper calls the refreshed animation hook.
  assert struct.unpack_from('<I',elf,off(a))[0]==0x0c000000|0x20a6800//4
  continue
 actual=struct.unpack_from('<I',elf,off(a))[0]
 assert actual in [old,new,oldhooks.get(k,[None,None])[1]],(hex(a),hex(actual))
 struct.pack_into('<I',elf,off(a),new)
cp=off(0x209fffc);struct.pack_into('<I',elf,cp,0);crc=0
for (w,) in struct.iter_unpack('<I',elf):crc^=w
struct.pack_into('<I',elf,cp,crc^0xaac5db56)
# Extend the existing scoped effect to the second uppercut as well.
from electric_effect import build as electric
code,hook=electric();elf[off(0x20a6800):off(0x20a6800)+len(code)]=code
elf[off(0x20a6b00):off(0x20a6b00)+128]=bytes(128)
elf[off(0x2a24f8):off(0x2a24f8)+4]=hook
struct.pack_into('<I',elf,cp,0);crc=0
for (w,) in struct.iter_unpack('<I',elf):crc^=w
struct.pack_into('<I',elf,cp,crc^0xaac5db56)
(R/'combined.elf').write_bytes(elf)
if '--elf-only' in sys.argv:sys.exit(0)
dest=R/'build';dest.mkdir(exist_ok=True)
target=Path(sys.argv[sys.argv.index('--output')+1]) if '--output' in sys.argv else dest/'Urban Reign Redux - Trial 13 Combat Follow-ups.iso'
refresh='--refresh' in sys.argv
if refresh:
 previous=json.loads((R/'build-validation.json').read_text())
 assert target.resolve()==Path(previous['candidate']).resolve()
 assert target.resolve().parent==dest.resolve()
 assert sha(target)==previous['sha256']
else:
 assert not target.exists()
 shutil.copyfile(source,target)
oldmodel=(R/'jack-jaw/baseline.vmd').read_bytes();newmodel=(R/'jack-jaw/Jack5.vmd').read_bytes()
assert len(oldmodel)==len(newmodel)
copies=json.loads((R/'jack-jaw/iso-copies.json').read_text())
modified=[(pos,bytes(elf))]+[(p,newmodel) for p in copies]
modified.sort()
with target.open('r+b') as f:
 for at,data in modified:
  if at!=pos:
   f.seek(at);assert f.read(len(data))==(newmodel if refresh else oldmodel)
  f.seek(at);f.write(data)
with source.open('rb') as a,target.open('rb') as b:
 cursor=0
 for at,data in modified+[(source.stat().st_size,b'')]:
  assert at>=cursor
  n=at-cursor;a.seek(cursor);b.seek(cursor)
  while n:
   k=min(n,16*1024*1024);assert a.read(k)==b.read(k);n-=k
  assert b.read(len(data))==data
  cursor=at+len(data)
report=dict(candidate=str(target),sha256=sha(target),source=str(source),source_sha256=expected,other_assets_unchanged=True,jack_jaw_copies=len(copies),electricity_preserved=True,installed=False,runtime_verified=False)
(R/'build-validation.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2),flush=True)
