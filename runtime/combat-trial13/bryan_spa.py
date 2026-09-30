"""Private SPA1 records; original 150 damage and 400 gauge cost preserved."""
import json,struct
def append(actions,reactions,hits,branches,manifest,banks,clone,ac,R,spa_rows):
    stages=json.loads((R/'bryan-spa/stages.json').read_text())
    native=3002;total=sum(h[2] for h in ac[native]['hits'])
    cost=struct.unpack_from('<I',bytes.fromhex(ac[native]['raw']),16)[0]
    assert total==150 and cost==400
    weights=[sum(h['damage'] for h in s['hits']) for s in stages]
    damage=[round(total*w/sum(weights)) for w in weights];damage[-1]+=total-sum(damage)
    ids=[]
    for i,s in enumerate(stages):
        # Use the native SPA body-punch stagger to retain opponents during
        # the rapid volley; ordinary medium reactions push them out of reach.
        template=1472 if i==len(stages)-1 else 2570
        a=clone('Bryan',s['key'],template);ids.append(a)
        rec=bytearray.fromhex(ac[template]['reaction_raw']);ri=len(reactions)//236;hi=len(hits)//18
        assert len(s['hits'])==1
        h=s['hits'][0];limb={'LH':(13,12),'RH':(9,8)}[h['limb']]
        hits.extend(struct.pack('<9h',*h['active'],damage[i],h['height'],*limb,-1,-1,-1))
        struct.pack_into('<HHH',rec,0xc0,hi,1,h['height']);reactions.extend(rec)
        struct.pack_into('<h',actions,a*64,0);struct.pack_into('<hh',actions,a*64+6,0,s['frames']-1)
        struct.pack_into('<II',actions,a*64+12,1,cost if i==0 else 0)
        struct.pack_into('<H',actions,a*64+0x38,ri)
        struct.pack_into('<II',actions,a*64+0x28,0,0);struct.pack_into('<H',actions,a*64+0x30,0)
        struct.pack_into('<HH',actions,a*64+0x3c,0,0)
        banks.append((43,0x10000+a,(R/'bryan-spa/attack-retargets'/f"{s['key']}.gyu").read_bytes()))
        manifest[-1].update(label=s['label'],source='Bryan',source_ids=s['source_ids'],spa=True,native_spa=native,
            spa_cost=cost if i==0 else 0,damage=damage[i],hit_class='heavy' if i==len(stages)-1 else 'spa body stagger',
            full_final_recovery=i==len(stages)-1,contact_radius_multiplier=1.5)
    for i,a in enumerate(ids[:-1]):
        at=max(h['active'][1] for h in stages[i]['hits'])+1
        row=[ids[i+1],0,-10,57,at,at,0,0,0,0,0,0,0,0,0]
        bi=len(branches)//30;branches.extend(struct.pack('<15h',*row))
        struct.pack_into('<HH',actions,a*64+0x32,bi,1)
        next(m for m in manifest if m['id']==a)['continuation']=[row]
    spa_rows.append((43,1,-1,ids[0]))
    (R/'bryan-spa-report.json').write_text(json.dumps(dict(actions=ids,native_action=native,total_damage=total,
        damage=damage,cost=cost,source_moves=[s['source_ids'] for s in stages],taunt=False,runtime_verified=False),indent=2))
    return ids
