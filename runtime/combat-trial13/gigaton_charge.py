"""Jack-only held-button Gigaton windups; one cost, five charge levels."""
import struct,json
from combat_routing import Asm

def append(actions,reactions,hits,branches,manifest,banks,clone,R,spa_rows,protected):
    base_release=4204
    def reaction(a):
        r=struct.unpack_from('<H',actions,a*64+0x38)[0]
        return bytearray(reactions[r*236:(r+1)*236])
    base=bytes(actions[base_release*64:(base_release+1)*64]);cost=struct.unpack_from('<I',base,16)[0]
    rec=reaction(base_release);hi,hn=struct.unpack_from('<HH',rec,0xc0)
    base_damage=[struct.unpack_from('<h',hits,(hi+j)*18+4)[0] for j in range(hn)]
    assert cost>0 and hn>0
    windups=[]
    for i in range(5):
        a=clone('Jack5',f'Gigaton windup {i+1}',3009);windups.append(a)
        actions[a*64:(a+1)*64]=base
        name='first-windup' if i==0 else 'loop'
        blob=(R/'remaining-additions/attack-retargets'/f'T13-Jack5-gigaton-{name}.gyu').read_bytes()
        banks.append((45,0x10000+a,blob));end=28 if i==0 else 24
        struct.pack_into('<hhh',actions,a*64+4,-2,0,end)
        struct.pack_into('<II',actions,a*64+12,1,cost if i==0 else 0)
        blank=bytearray(rec);struct.pack_into('<H',blank,0xc2,0)
        struct.pack_into('<H',actions,a*64+0x38,len(reactions)//236);reactions.extend(blank)
        manifest[-1].update(spa=True,spa_cost=cost if i==0 else 0,spa_protection=True,charge_level=i+1,charge_windup=True,encoded_frames=end+1)
        protected.append(a)
    releases=[base_release]
    for i in range(1,5):
        a=clone('Jack5',f'Gigaton release level {i+1}',3009);actions[a*64:(a+1)*64]=base
        releases.append(a);banks.append((45,0x10000+a,next(b for c,k,b in banks if k==0x10000+base_release)))
        newrec=bytearray(rec);newhi=len(hits)//18
        for j,d in enumerate(base_damage):
            h=bytearray(hits[(hi+j)*18:(hi+j+1)*18]);struct.pack_into('<h',h,4,round(d*(1+.4*i)));hits.extend(h)
        struct.pack_into('<H',newrec,0xc0,newhi)
        struct.pack_into('<H',actions,a*64+0x38,len(reactions)//236);reactions.extend(newrec)
        manifest[-1].update(spa=True,spa_cost=0,spa_protection=True,charge_level=i+1,damage_multiplier=1+.4*i,full_final_recovery=True)
        protected.append(a)
    for a in releases:
        struct.pack_into('<I',actions,a*64+16,0)
        next(m for m in manifest if m['id']==a)['spa_cost']=0
    for i,a in enumerate(windups):
        end=struct.unpack_from('<h',actions,a*64+8)[0]
        # Release at any point; completing another cycle increases its damage.
        rr=[[releases[max(0,i-1)],0,-10,45,0,0,57,1,end,0,0,0,0,0,0]]
        nxt=windups[i+1] if i<4 else releases[4]
        rr.append([nxt,0,-10,57,end-1,end,0,0,0,0,0,0,0,0,0])
        at=len(branches)//30
        for row in rr:branches.extend(struct.pack('<15h',*row))
        struct.pack_into('<HH',actions,a*64+0x32,at,len(rr))
        next(m for m in manifest if m['id']==a)['continuation']=rr
    spa_rows[:]=[x for x in spa_rows if x[:2]!=(45,1)];spa_rows.append((45,1,-1,windups[0]))
    a=Asm(0x2490000);a.i(9,29,29,-32);a.i(63,31,29,24);a.i(43,6,29,0)
    a.i(11,8,4,8);a.b(4,8,0,'native');a.r(0,8,0,4,2);a.li(9,0x59d168);a.r(0x21,8,8,9);a.i(35,8,8,0)
    a.b(4,8,0,'native');a.i(35,9,8,4);a.i(9,10,0,45);a.b(5,9,10,'native')
    a.li(9,0x8d40);a.r(0x21,9,8,9);a.i(35,9,9,0);a.i(9,9,9,-windups[0]);a.i(11,10,9,5);a.b(4,10,0,'native')
    a.li(9,0x89a0);a.r(0x21,8,8,9);a.i(35,9,8,0);a.i(11,10,9,8);a.b(4,10,0,'released')
    a.i(43,9,29,4);a.i(35,4,8,4);a.call(0x21cb48)
    a.r(0,8,0,2,4);a.li(9,0x461168);a.r(0x21,8,8,9);a.i(35,8,8,0)
    a.i(35,9,29,4);a.i(9,10,0,208);a.r(0x18,0,9,10);a.r(0x12,9,0)
    a.li(10,0x3597c0);a.r(0x21,9,9,10);a.i(35,9,9,0);a.r(0x24,8,8,9);a.r(0x2b,8,0,8);a.b(4,0,0,'compare')
    a.label('released');a.move(8,0)
    # Native a2 is the branch flags (-10), not a desired held-button value.
    # Every private condition-45 row means release when attack is not held.
    a.label('compare');a.i(11,2,8,1);a.b(4,0,0,'done')
    a.label('native');a.move(2,0)
    a.label('done');a.i(55,31,29,24);a.i(9,29,29,32);a.ret()
    report=dict(windups=windups,releases=releases,cost=cost,damage=[round(sum(base_damage)*(1+.4*i)) for i in range(5)],held_condition=45,runtime_verified=False)
    (R/'gigaton-charge.json').write_text(json.dumps(report,indent=2))
    return [(a.base,a.finish())],{0x218aa8:(0x0c000000|0x216ec8//4,0x0c000000|a.base//4)}
