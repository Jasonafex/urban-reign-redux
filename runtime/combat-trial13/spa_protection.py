"""Reuse the native SPA no-hit predicate for the imported SPA actions."""
import struct
from idle_routing import Asm

def protection(elf,actions):
    base=0x20b3600;table=0x2491000
    a=Asm(base)
    a.r(0,8,0,4,2);a.li(9,0x59d168);a.r(0x21,8,8,9);a.i(35,8,8,0)
    a.b(4,8,0,'native');a.li(9,0x8d40);a.r(0x21,8,8,9);a.i(35,8,8,0)
    a.li(9,table)
    a.label('scan');a.i(35,10,9,0);a.i(9,11,0,-1);a.b(4,10,11,'native')
    a.b(4,8,10,'protected');a.i(9,9,9,4);a.b(4,0,0,'scan')
    a.label('protected');a.i(9,2,0,1);a.ret()
    a.label('native');a.jump(0x2146f0)
    code=a.finish();data=struct.pack('<'+'i'*(len(actions)+1),*actions,-1)
    assert len(code)<=0x200 and len(data)<=0x400
    hooks={}
    for address in range(0x100000,0x300000,4):
        old=struct.unpack_from('<I',elf,address-0xff000)[0]
        if old==0x0c000000|0x2146f0//4:hooks[address]=(old,0x0c000000|base//4)
    assert len(hooks)==4
    return [(base,code),(table,data)],hooks
