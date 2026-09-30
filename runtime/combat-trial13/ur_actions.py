"""Native Urban Reign action, collision and continuation records."""
from pathlib import Path
import struct,json
R=Path(__file__).resolve().parent
ACTION=0x4616f0
REACTION=0x4ab768
HIT=0x51e5a0
BRANCH=0x5338d8

def action(r,i):
    p=ACTION+64*i;b=r[p:p+64]
    ai=struct.unpack_from('<H',b,0x38)[0]
    at=r[REACTION+ai*236:REACTION+(ai+1)*236]
    hi,hn=struct.unpack_from('<HH',at,0xc0)
    bi,bn=struct.unpack_from('<HH',b,0x32)
    return dict(id=i,motion=struct.unpack_from('<h',b)[0],state=struct.unpack_from('<h',b,2)[0],
        end_action=struct.unpack_from('<h',b,4)[0],start_frame=struct.unpack_from('<h',b,6)[0],end_frame=struct.unpack_from('<h',b,8)[0],
        reaction_index=ai,hit_index=hi,hits=[list(struct.unpack_from('<9h',r,HIT+18*(hi+j))) for j in range(hn)],
        branch_index=bi,branches=[list(struct.unpack_from('<15h',r,BRANCH+30*(bi+j))) for j in range(bn)],raw=b.hex(),reaction_raw=at.hex())

if __name__=='__main__':
    r=(R/'runtime/Violet-scaled-fresh/eeMemory.bin').read_bytes()
    report={}
    for name,style in [('Violet',88),('Dragunov',80),('Kazuya',51)]:
        p=struct.unpack_from('<I',r,0x59b560+style*4)[0]
        roots=struct.unpack_from('<12h',r,p+0x1c2)
        ids=set(roots);pending=list(roots)
        while pending:
            i=pending.pop()
            if i<0:continue
            for b in action(r,i)['branches']:
                if 0<=b[0]<3950 and b[0] not in ids:ids.add(b[0]);pending.append(b[0])
        report[name]=dict(style=style,style_address=p,roots=list(roots),actions=[action(r,i) for i in sorted(ids) if i>=0])
    (R/'ur-native-attack-chains.json').write_text(json.dumps(report,indent=2))
    for n,x in report.items():
        print(n,'roots',x['roots'])
        for a in x['actions']:print(a['id'],'motion',a['motion'],'frames',a['end_frame'],'hits',a['hits'],'branches',a['branches'])
