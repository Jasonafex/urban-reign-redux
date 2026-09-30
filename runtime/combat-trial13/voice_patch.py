"""Use native character voice routing at action entry, preserving its throttle."""
import struct
from idle_routing import Asm

def voice_patch(manifest,ids):
 base=0x20b2400;table=0x20b2800;rows=[]
 for i,m in enumerate(manifest):
  if m.get('spa'):
   if m.get('spa_cost',0)>0:rows.append((m['id'],0x70000007))
   continue
  if 'source_move' not in m and 'source_ids' not in m:continue
  if m['id']==ids['Kazuya',494] or m.get('electric_wind_god_fist'):voice=3 # event3 maps to tone2, Kazuya Heavy1
  elif i%3==0:voice=1+(i//3)%4
  else:continue
  rows.append((m['id'],0x10000000|voice));m['voice_event']=voice
 a=Asm(base);a.i(9,29,29,-32);a.i(63,31,29,24);a.i(43,4,29,0)
 a.call(0x213d50);a.i(43,2,29,4);a.i(35,8,29,0);a.li(9,table)
 a.label('scan');a.i(35,10,9,0);a.i(9,11,0,-1);a.b(4,10,11,'done');a.b(4,8,10,'play')
 a.i(9,9,9,8);a.b(4,0,0,'scan')
 a.label('play');a.i(35,6,9,4);a.move(7,17);a.call(0x284a00)
 a.label('done');a.i(35,2,29,4);a.i(55,31,29,24);a.i(9,29,29,32);a.ret()
 data=b''.join(struct.pack('<II',*row) for row in rows)+struct.pack('<II',0xffffffff,0)
 assert len(a.finish())<0x400 and len(data)<0x400
 # Only this action-entry call has s1=actor slot. General state queries stay native.
 return [(base,a.finish()),(table,data)],{0x253d84:(0x0c000000|0x213d50//4,0x0c000000|base//4)}
