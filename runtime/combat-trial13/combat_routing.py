"""Guarded per-actor idle descriptors, leaving native action IDs untouched."""
import struct

BASE=0x020b0000
TABLE=BASE+0x4000
DESCRIPTORS=BASE+0x3800
BANKS=BASE+0x8000

class Asm:
    def __init__(self,base):self.base=base;self.words=[];self.labels={};self.fix=[]
    def i(self,op,rt,rs,k):self.words.append(op<<26|rs<<21|rt<<16|(k&65535))
    def r(self,fn,rd,rs,rt=0,sh=0):self.words.append(rs<<21|rt<<16|rd<<11|sh<<6|fn)
    def li(self,r,v):self.i(15,r,0,v>>16);self.i(13,r,r,v&65535)
    def move(self,rd,rs):self.r(0x21,rd,rs)
    def label(self,n):self.labels[n]=self.base+4*len(self.words)
    def b(self,op,rs,rt,label):self.fix.append((len(self.words),label));self.i(op,rt,rs,0);self.words.append(0)
    def call(self,a):self.words.extend([0x0c000000|a//4,0])
    def jump(self,a):self.words.extend([0x08000000|a//4,0])
    def ret(self):self.words.extend([0x03e00008,0])
    def finish(self):
        for i,label in self.fix:
            delta=(self.labels[label]-(self.base+i*4+4))//4
            assert -32768<=delta<32768;self.words[i]|=delta&65535
        return struct.pack('<%dI'%len(self.words),*self.words)

def code():
    # Selector(a0=motion ID, a1=controller) -> v0 descriptor. Native lookup
    # remains the default, including its invalid-ID behavior.
    a=Asm(BASE);a.i(9,29,29,-32);a.i(63,31,29,24);a.i(43,4,29,0);a.i(43,5,29,4)
    a.call(0x2a21f0);a.i(35,4,29,0);a.i(35,5,29,4)
    a.li(8,0x6646f0);a.li(9,0);a.li(10,8)
    a.label('actor_loop');a.b(4,8,5,'actor_found');a.i(9,8,8,20);a.i(9,9,9,1)
    a.b(5,9,10,'actor_loop');a.b(4,0,0,'done')
    a.label('actor_found');a.li(8,0x59d168);a.r(0,10,0,9,2);a.r(0x21,8,8,10)
    a.i(35,8,8,0);a.b(4,8,0,'done');a.i(35,11,8,4)
    a.li(15,0x10000);a.r(0x21,15,8,15);a.i(35,15,15,-0x72c0)
    a.li(12,TABLE)
    a.label('table_loop');a.i(35,13,12,0);a.i(9,14,0,-1);a.b(4,13,14,'done')
    a.i(9,14,0,-2);a.b(4,13,14,'character_match');a.b(5,13,11,'next');a.label('character_match')
    a.i(35,13,12,4);a.r(2,14,0,13,16);a.b(4,14,0,'motion_key')
    a.li(14,0x10000);a.r(0x23,13,13,14);a.b(4,13,15,'matched');a.b(4,0,0,'next')
    a.label('motion_key');a.b(4,13,4,'matched')
    a.label('next');a.i(9,12,12,28);a.b(4,0,0,'table_loop')
    a.label('matched');a.li(8,DESCRIPTORS);a.r(0,10,0,9,5);a.r(0,9,0,9,3)
    a.r(0x21,10,10,9);a.r(0x21,8,8,10)
    # Retain validity, metadata and events. Separate descriptor buffers
    # prevent cross-actor aliasing; normalize the body-only format below.
    for off in range(0,40,4):a.i(35,10,2,off);a.i(43,10,8,off)
    # Body-only replacement banks have 21 tracks. Type 3 expects two extra
    # independent weapon tracks and otherwise leaves a stale weapon matrix.
    a.i(9,10,0,2);a.i(43,10,8,0)
    # A borrowed paired throw may have no registered native descriptor.
    # Supplied replacement banks are complete one-record GYU animations.
    a.i(9,10,0,1);a.i(43,10,8,4);a.i(43,10,8,8)
    for i in range(5):a.i(35,10,12,8+4*i);a.i(43,10,8,12+4*i)
    a.move(2,8)
    a.label('done');a.i(55,31,29,24);a.i(9,29,29,32);a.ret()
    selector=a.finish();assert len(selector)<0x400
    setter=Asm(BASE+0x400);setter.move(5,16);setter.jump(BASE)
    # Refresh descriptor before rendering, including when an old saved state
    # is loaded. v0 must still return the original controller to the caller.
    refresh=Asm(BASE+0x440);refresh.i(9,29,29,-32);refresh.i(63,31,29,24)
    refresh.call(0x2a20b0);refresh.i(43,2,29,0);refresh.i(35,4,2,0);refresh.move(5,2)
    refresh.call(BASE);refresh.i(35,3,29,0);refresh.i(43,2,3,16);refresh.move(2,3)
    refresh.i(55,31,29,24);refresh.i(9,29,29,32);refresh.ret()
    # Battle height queries carry the actor in s3. Transition/root queries
    # share a native helper without an actor argument, so recognize its five
    # audited callers using the caller return address saved by that helper.
    height=Asm(BASE+0x500);height.move(9,19);height.jump(BASE+0x680)
    query=Asm(BASE+0x540);query.i(35,8,29,0x30)
    for address,label in [(0x254568,'s2'),(0x254764,'slot'),(0x2548b4,'s2'),
                          (0x2548f0,'s2'),(0x2a294c,'fp')]:
        query.li(10,address);query.b(4,8,10,label)
    query.jump(0x2a21f0)  # Unknown callers retain the exact native lookup.
    query.label('s2');query.move(9,18);query.jump(BASE+0x680)
    query.label('fp');query.move(9,30);query.jump(BASE+0x680)
    query.label('slot');query.li(10,0x59d168);query.r(0x23,9,16,10)
    query.r(2,9,0,9,2);query.jump(BASE+0x680)
    controller=Asm(BASE+0x680);controller.r(0,10,0,9,4);controller.r(0,9,0,9,2)
    controller.r(0x21,9,9,10);controller.li(5,0x6646f0)
    controller.r(0x21,5,5,9);controller.jump(BASE)
    facing=Asm(BASE+0x4a0);facing.i(35,8,4,0x128);facing.i(9,9,0,45)
    facing.b(5,8,9,'done');facing.li(8,struct.unpack('<I',struct.pack('<f',15.775/360))[0])
    facing.words.extend([0x44880800,0x46016300]) # mtc1 t0,f1; add.s f12,f12,f1
    facing.label('done');facing.jump(0x1e8120)
    assert 0x440+len(refresh.finish())<=0x4a0 and len(facing.finish())<=0x60
    # Gun 22 is selectable but its native flag skips preview registration.
    # Its model is already in the loaded pack; include its registry entry.
    # Fresh Multiplayer entry verified the 40,607-byte resource and capacity.
    gun=Asm(BASE+0x6c0);gun.b(5,3,0,'load');gun.i(9,1,0,22);gun.b(4,19,1,'load')
    gun.jump(0x1d3ae8);gun.label('load');gun.jump(0x1d3a6c)
    assert len(gun.finish())<=0x40
    # Gameplay also consults the original action's end frame. Use the bank
    # duration only for an actor's replacement idle with native -2 loop action.
    end=Asm(BASE+0x700);end.i(9,29,29,-32);end.i(63,31,29,24);end.i(43,4,29,0)
    end.call(0x213d98)
    end.i(35,8,29,0);end.i(11,9,8,3950);end.b(4,9,0,'done');end.r(0,8,0,8,6);end.li(9,0x25016f0);end.r(0x21,8,8,9)
    end.i(33,8,8,4);end.i(9,9,0,-2);end.b(5,8,9,'done')
    end.r(0,8,0,16,4);end.r(0,9,0,16,2);end.r(0x21,8,8,9)
    end.li(9,0x6646f0);end.r(0x21,9,9,8);end.i(35,9,9,16)
    end.r(0,8,0,8,1);end.li(10,DESCRIPTORS);end.r(0x21,8,8,10)
    end.b(5,8,9,'done');end.i(35,8,9,12);end.i(35,2,8,0)
    end.label('done');end.i(55,31,29,24);end.i(9,29,29,32);end.ret()
    assert len(end.finish())<=0x100
    blob=bytearray(0x800);blob[:len(selector)]=selector
    assert len(query.finish())<=0x140
    for obj in (setter,refresh,height,query,controller,end,facing,gun):b=obj.finish();off=obj.base-BASE;blob[off:off+len(b)]=b
    hooks={0x2a2084:(0x0c000000|0x2a21f0//4,0x0c000000|(BASE+0x400)//4),
           0x2a24f8:(0x0c000000|0x2a20b0//4,0x0c000000|(BASE+0x440)//4),
           0x20b928:(0x0c000000|0x2a21f0//4,0x0c000000|(BASE+0x500)//4),
           0x2a2258:(0x0c000000|0x2a21f0//4,0x0c000000|(BASE+0x540)//4),
           0x20b628:(0x0c000000|0x213d98//4,0x0c000000|(BASE+0x700)//4),
           0x1e818c:(0x0c000000|0x1e8120//4,0x0c000000|(BASE+0x4a0)//4),
           0x1d3a64:(0x10600020,0x08000000|(BASE+0x6c0)//4)}
    return blob,hooks

def payload(rows):
    """rows: (character ID, original idle ID, complete one-record GYU bank)."""
    from build_idle_candidate import parse_gyu
    blob=bytearray(BANKS-BASE);instructions,hooks=code();blob[:len(instructions)]=instructions
    for i,(character,motion,bank) in enumerate(rows):
        assert (i+2)*28<=BANKS-TABLE
        offset=len(blob);address=BASE+offset;record=parse_gyu(bank)['records'][0]
        struct.pack_into('<7I',blob,TABLE-BASE+i*28,character,motion,address+record['offset'],
                         address+4,address+8,address+record['offset']+4,address+record['tracks_base'])
        blob.extend(bank);blob.extend(bytes((-len(blob))%16))
    struct.pack_into('<I',blob,TABLE-BASE+len(rows)*28,0xffffffff)
    return blob,hooks
