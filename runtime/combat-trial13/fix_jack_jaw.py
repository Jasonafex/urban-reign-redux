"""Reduce only Jack's jaw weighting, keeping closed geometry and texture bytes."""
from pathlib import Path
import sys,struct,json,hashlib,subprocess
import numpy as np
R=Path(__file__).resolve().parent;ROOT=R.parents[2];O=R/'jack-jaw'
sys.path.insert(0,str(ROOT/'Release/Urban Reign Asset Studio/Application'))
from model import Model,decode_vertices
m=Model((O/'baseline.vmd').read_bytes());raw=bytearray(m.data);changed=[];factor=.35
native=Model((ROOT/'work/expansion-research/facial-restoration/bundle-v4/Jack5/native.vmd').read_bytes())
node=m.raw['skeleton']['nodes'][40];pivot=native.raw['skeleton']['nodes'][40]['raw_translation_float4_at_16']
struct.pack_into('<4f',raw,node['offset']+16,*pivot)
newbind=Model(bytes(raw));conversion=np.linalg.inv(newbind.mats[40])@m.mats[40]
for v in m.vertices:
 for inf in v['influences']:
  if inf['bone']!=40:continue
  pos=conversion@np.r_[inf['position'],inf['weight']]
  normal=conversion[:3,:3]@np.array(inf['normal'])
  struct.pack_into('<3f',raw,inf['offset'],*pos[:3])
  struct.pack_into('<3f',raw,inf['normal_offset'],*normal)
  changed.append(v['id'])
n=Model(bytes(raw));err=float(np.abs(n.positions-m.positions).max());assert err<1e-6,err
assert not n.diagnostics()['bad_weight_sums'];assert np.array_equal(n.uv,m.uv);assert np.array_equal(n.indices,m.indices)
assert all(n.textures[k]['png']==v['png'] for k,v in m.textures.items())
(O/'Jack5.vmd').write_bytes(raw)
diff=[i for i,(a,b) in enumerate(zip(raw,m.data)) if a!=b]
report=dict(source_sha256=m.hash,sha256=n.hash,native_animated_jaw_pivot_restored=True,changed_vertices=len(changed),closed_pose_max_error=err,uv_preserved=True,textures_preserved=True,other_bones_preserved=True,changed_bytes=diff,runtime_verified=False)
(O/'validation.json').write_text(json.dumps(report,indent=2));print({k:v for k,v in report.items() if k!='changed_bytes'})
# Match the supplied pain pose, without retaining an expanded RAM dump.
state=Path('D:/Media/Projects/Personal Art/Image Training/Urban Reign_SLUS-21209_20260929123055.p2s')
ram=subprocess.run(['C:/Program Files/7-Zip/7z.exe','x','-so',str(state),'eeMemory.bin'],check=True,capture_output=True).stdout
actor=struct.unpack_from('<I',ram,0x59d168)[0];assert struct.unpack_from('<I',ram,actor+4)[0]==45
mats=np.frombuffer(ram,dtype='<f4',offset=actor+0x120,count=len(m.mats)*16).reshape(-1,4,4).transpose(0,2,1).copy()
# Express the captured pose in the model's neutral head frame for comparison.
transform=m.mats[3]@np.linalg.inv(mats[3]);mats=np.einsum('ij,njk->nik',transform,mats)
for label,model in [('before',m),('after',n)]:
 p,norm=decode_vertices(model.raw,mats)
 textures={}
 for k,v in model.textures.items():
  f=O/f'texture-{k}.png';f.write_bytes(v['png']);textures[str(k)]=str(f.resolve())
 data=dict(name=label,positions=p.tolist(),normals=norm.tolist(),faces=model.indices.tolist(),uv=model.uv.tolist(),samplers=[str(model.draws[f['draw']]['sampler']) for f in model.faces],textures=textures,alpha_tests={str(k):v['alpha_test'] for k,v in model.textures.items()},head_origin=[0,.74,0],focus=[0,-.14,.80],scale=.32,camera_offset=[.2,-2,0])
 (O/f'{label}.json').write_text(json.dumps(data))
