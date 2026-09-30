"""Cammy uses native submission throws, scoped to her unarmed style."""
import struct
from idle_routing import Asm

def grab_patch(ram,elf,ids):
 chunks=[];hooks={}
 # Each query has its own table shape; retain donor action and paired-victim
 # records intact so native contact alignment, damage and escapes still run.
 for i,(original,offset,stride,count) in enumerate([(0x2138c8,0x232,15,60),(0x213948,0x222,2,8),(0x2139c8,0x2aa,2,8)]):
  base=0x20b2c00+i*0x200;table=0x20b3300+i*0x100
  donor=struct.unpack_from('<I',ram,0x59b560+85*4)[0]
  data=ram[donor+offset:donor+offset+count*2]
  a=Asm(base);a.i(9,29,29,-32);a.i(63,31,29,24)
  for reg,off in [(4,0),(5,4),(6,8)]:a.i(43,reg,29,off)
  a.call(original);a.i(35,8,29,0);a.r(0,8,0,8,2);a.li(9,0x59d168);a.r(0x21,8,8,9);a.i(35,8,8,0)
  a.i(35,12,8,4)
  a.li(9,0x8d86);a.r(0x21,8,8,9);a.i(37,9,8,0);a.i(37,10,8,2);a.b(5,9,10,'done')
  a.i(35,9,29,4);a.i(35,10,29,8)
  if original==0x2138c8:
   # Compact table lookup leaves room for the three additional paired throws.
   custom=0x20b3b00
   rows=[(45,0,ids['Jack5','Rotary Catapult']),(16,0,ids['Kazuya','Double Face Kick']),
         (15,0,ids['Jin','Tidal Wave']),(53,0,ids['Heihachi','Jumping Powerbomb']),(53,1,ids['Heihachi','Freefall']),
         (46,1,ids['Kiryu','Blizzard Rush'])]
   chunks.append((custom,b''.join(struct.pack('<3i',*r) for r in rows)+struct.pack('<3i',-1,0,0)))
   a.i(11,11,10,3);a.b(4,11,0,'other');a.li(13,custom)
   a.label('custom_scan');a.i(35,11,13,0);a.i(9,14,0,-1);a.b(4,11,14,'other');a.b(5,11,12,'custom_next')
   a.i(35,11,13,4);a.b(5,11,9,'custom_next');a.i(35,2,13,8);a.b(4,0,0,'done')
   a.label('custom_next');a.i(9,13,13,12);a.b(4,0,0,'custom_scan');a.label('other')
  a.i(9,11,0,31);a.b(5,12,11,'done')
  if stride==15:a.r(0,11,0,9,4);a.r(0x23,9,11,9)
  else:a.r(0,9,0,9,1)
  a.r(0x21,9,9,10);a.i(11,10,9,count);a.b(4,10,0,'done');a.r(0,9,0,9,1);a.li(10,table);a.r(0x21,9,9,10);a.i(33,2,9,0)
  a.label('done');a.i(55,31,29,24);a.i(9,29,29,32);a.ret()
  assert len(a.finish())<0x200
  chunks.extend([(base,a.finish()),(table,data)])
  for address in range(0x100000,0x300000,4):
   old=struct.unpack_from('<I',elf,address-0xff000)[0]
   if old==0x0c000000|original//4:hooks[address]=(old,0x0c000000|base//4)
 return chunks,hooks
