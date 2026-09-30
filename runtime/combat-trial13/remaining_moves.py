"""Trial 13 remaining strings. All records are private; native tables stay intact."""
import json,struct
import numpy as np
from scipy.spatial.transform import Rotation,Slerp
from build_idle_candidate import encode,parse_gyu,decode_track_samples

def apply(ram,actions,reactions,hits,branches,manifest,ids,banks,mapping,chars,clone,ac,R,spa_rows,radius,protected):
    D=R/'remaining-additions'
    stages={s['key']:s for s in json.loads((D/'stages.json').read_text())}
    requests=json.loads((D/'request.json').read_text())['chains']
    meta={m['id']:m for m in manifest};paths={};green=[]
    templates={'medium':2786,'heavy':1472,'launch':1494,'sweep':1220,'stagger':2570}
    floor={'medium':30,'heavy':45,'launch':35,'sweep':40,'stagger':20}
    ends={'RH':(9,8),'LH':(13,12),'RF':(17,15),'LF':(21,19)}
    def values(key):return np.load(D/'attack-retargets'/f'{key}.npy').copy()
    def rows(a):
        i,n=struct.unpack_from('<HH',actions,a*64+0x32)
        return [list(struct.unpack_from('<15h',branches,(i+j)*30)) for j in range(n)]
    def setrows(a,rr):
        i=len(branches)//30
        for row in rr:branches.extend(struct.pack('<15h',*row))
        struct.pack_into('<HH',actions,a*64+0x32,i,len(rr));meta[a]['continuation']=rr
    def walk(a):
        todo=[a];seen=[]
        while todo:
            a=todo.pop(0)
            if a<3950 or a in seen:continue
            seen.append(a);n=struct.unpack_from('<h',actions,a*64+4)[0]
            todo.extend([n] if n>=3950 else [z[0] for z in rows(a) if z[0]>=3950])
        return seen
    oldpaths={(c,d,b):walk(a) for c,d,b,a in mapping}
    def end(a):return struct.unpack_from('<h',actions,a*64+8)[0]
    def active_end(a):
        r=struct.unpack_from('<H',actions,a*64+0x38)[0];i,n=struct.unpack_from('<HH',reactions,r*236+0xc0)
        return max(struct.unpack_from('<h',hits,(i+j)*18+2)[0] for j in range(n))
    def link(a,b,recover=.35,automatic=False):
        last=active_end(a);e=end(a);at=min(e-1,last+max(1,round((e-last)*recover)))
        if automatic:rr=[[b,0,-10,57,at,at,0,0,0,0,0,0,0,0,0]]
        else:rr=[[b,0,0,57,1,e-1,43,0,0,0,0,0,0,0,0],[-2,0,-10,57,at,e-1,0,0,0,0,0,0,0,0,0]]
        setrows(a,rr);meta[a]['recovery_fraction_before_extension']=recover
    def root(name,d,a,b=None,powered=False):
        if b is None:b=0 if d==0 else -1
        row=(chars[name],d,b,a)
        if powered:green.append(row)
        else:
            mapping[:]=[x for x in mapping if x[:3]!=row[:3]];mapping.append(row)
    def join(v,tail,blend=6):
        tail=tail.copy();tail[:,0,[0,2]]+=v[-1,0,[0,2]]-tail[0,0,[0,2]]
        if not blend:return np.concatenate([v,tail])
        bridge=np.zeros((blend,21,3));ts=np.linspace(0,1,blend+2)[1:-1]
        bridge[:,0]=v[-1,0]*(1-ts[:,None])+tail[0,0]*ts[:,None]
        for k in range(2,21):bridge[:,k]=Slerp([0,1],Rotation.from_euler('xyz',np.stack([v[-1,k],tail[0,k]])*2*np.pi))(ts).as_euler('xyz')/(2*np.pi)
        return np.concatenate([v,bridge,tail])
    def build(s,kind,travel=1.,startup=1.,tail=None,prepend=None,spa=None,damage=None):
        s=dict(s);v=values(s['key']);hh=[dict(h,active=h['active'].copy()) for h in s['hits']]
        if prepend:
            pre=values(prepend);v=join(pre,v,0)
            for h in hh:h['active']=[t+len(pre) for t in h['active']]
        onset=min(h['active'][0] for h in hh)
        if startup!=1:
            new_onset=round(onset*startup);sample=np.r_[np.linspace(0,onset,new_onset+1),np.arange(onset+1,len(v))]
            out=np.zeros((len(sample),21,3));out[:,0]=np.stack([np.interp(sample,np.arange(len(v)),v[:,0,k]) for k in range(3)],axis=1)
            for k in range(2,21):out[:,k]=Slerp(np.arange(len(v)),Rotation.from_euler('xyz',v[:,k]*2*np.pi))(sample).as_euler('xyz')/(2*np.pi)
            v=out
            for h in hh:h['active']=[t+new_onset-onset for t in h['active']]
        v[:,0,[0,2]]=v[0,0,[0,2]]+(v[:,0,[0,2]]-v[0,0,[0,2]])*travel
        if tail:v=join(v,values(tail))
        a=clone(s['target'],s['key'],templates[kind]);meta[a]=manifest[-1]
        ri=len(reactions)//236;hi=len(hits)//18;rec=bytearray.fromhex(ac[templates[kind]]['reaction_raw'])
        for h in hh:
            dmg=max(h['damage'],floor[kind]) if damage is None else damage
            hitends=[n for limb in h.get('collision_limbs',[h['limb']]) for n in ends[limb]]
            hitends=(hitends+[-1]*4)[:4]
            hits.extend(struct.pack('<9h',*h['active'],dmg,h['height'],*hitends,-1))
        struct.pack_into('<HHH',rec,0xc0,hi,len(hh),hh[0]['height']);reactions.extend(rec)
        struct.pack_into('<hhh',actions,a*64+4,-2,0,len(v)-1);struct.pack_into('<h',actions,a*64,0)
        struct.pack_into('<H',actions,a*64+0x38,ri)
        struct.pack_into('<II',actions,a*64+12,1 if spa else 0,spa[1] if spa else 0)
        struct.pack_into('<II',actions,a*64+0x28,0,0);struct.pack_into('<H',actions,a*64+0x30,0);struct.pack_into('<HH',actions,a*64+0x3c,0,0)
        blob,err=encode(v);banks.append((chars[s['target']],0x10000+a,blob));radius[a]=1.5
        meta[a].update(label=s['label'],source=s['source'],source_ids=s['source_ids'],hit_class=kind,hits=hh,encoded_frames=len(v),full_final_recovery=True,travel=travel,codec_error=err)
        if tail:meta[a]['recovery_animation']=tail
        if prepend:meta[a]['windup_animation']=prepend
        if spa:
            protected.append(a);meta[a].update(spa=True,native_spa=spa[0],spa_cost=spa[1],spa_protection=True)
        return a
    for request in requests:
        n,d=request['character'],request['direction'];ss=[stages[k] for k in request['stages']];chain=[]
        native={('Jack5','spa1'):3009,('Jack5','spa2'):1524,('Heihachi','spa1'):2910,('Heihachi','spa2'):2774}.get((n,d))
        total=sum(h[2] for h in ac[native]['hits']) if native else None
        cost=struct.unpack_from('<I',bytes.fromhex(ac[native]['raw']),16)[0] if native else 0
        damage=None
        if native:
            weights=[sum(h['damage'] for h in s['hits']) for s in ss];damage=[round(total*w/sum(weights)) for w in weights];damage[-1]+=total-sum(damage)
        for i,s in enumerate(ss):
            last=i==len(ss)-1;kind='heavy' if last else 'medium'
            travel=2. if n in ['Jack5','Heihachi'] else 1.;startup=1.;tail=prepend=None
            if s['finish']=='launch':kind='launch'
            elif s['finish']=='sweep':kind='sweep'
            if (n,d)==('Jin','down') and i==0:kind='sweep'
            if (n,d)==('Jin','down') and last:tail='T13-Jin-getup'
            if (n,d)==('Hwoarang','up') and i==0:prepend='T13-Hwoarang-bolt-windup'
            if (n,d)==('King','side') and last:tail='T13-King-kip-up'
            if (n,d)==('King','up'):prepend='T13-King-boomerang-windup';tail='T13-King-belly-getup'
            if (n,d)==('Heihachi','spa1'):startup=60./s['hits'][0]['active'][0]
            if native and not last:kind='stagger'
            if (n,d)==('Jack5','spa2') and i==3:travel=1.5
            a=build(s,kind,travel,startup,tail,prepend,(native,cost if i==0 else 0) if native else None,damage[i] if native else None)
            chain.append(a)
        for i,(a,b) in enumerate(zip(chain,chain[1:])):
            recovery=.35
            if (n,d) in [('Hwoarang','up'),('Jack5','up'),('Heihachi','up')] and i==len(chain)-2:recovery=.8
            if (n,d)==('Hwoarang','up') and i==0:recovery=.8
            if (n,d)==('Heihachi','side') and i==1:recovery=.8
            if (n,d)==('King','side') and i==1:recovery=.8
            if (n,d)==('King','neutral') and i==2:recovery=1.
            link(a,b,recovery,automatic=native is not None)
        paths[n+'/'+d]=chain
        if native:
            spa_rows[:]=[x for x in spa_rows if x[:2]!=(chars[n],1 if d=='spa1' else 3)]
            spa_rows.append((chars[n],1 if d=='spa1' else 3,-1,chain[0]));continue
        if (n,d)==('Dragunov','side'):
            lead=[clone(n,'Native upper string '+str(i),i) for i in [2549,2550,2551]]
            for a in lead:meta[a]=manifest[a-3950]
            for a,b in zip(lead,lead[1:]):link(a,b)
            link(lead[-1],chain[0],.8);chain[:0]=lead
        if (n,d)==('Jin','neutral'):
            lead=oldpaths[15,0,0][:-1];link(lead[-1],chain[0],.6);chain[:0]=lead
        direction={'neutral':0,'up':1,'down':2,'side':3,'ground':2,'running':0}[d]
        root(n,direction,chain[0],4 if d=='ground' else 3 if d=='running' else None,n in ['King','Armor Queen'])
    # Latest Leon feedback: move the complete existing neutral string to side.
    D=R/'leon-followup';leon_stages=json.loads((D/'stages.json').read_text())
    knee=build(next(s for s in leon_stages if s['direction']=='side'),'launch')
    oldneutral=oldpaths[0,0,0];link(knee,oldneutral[0],.8)
    root('Leon',3,knee);paths['Leon/side']=[knee]+oldneutral
    # Supplied Armor King reference: final five contacts at approximately
    # 3.1, 3.6, 4.0, 4.7, 5.1 seconds (100ms sample precision).
    # Keep animation/contact frames intact and correct continuation timing.
    assert oldneutral==[4143,4144,4145,4146,4147]
    for a,at in zip(oldneutral[:-1],[33,27,31,36]):
        rr=rows(a)
        for row in rr:
            if row[0]<0:row[4]=at
            row[5]=max(row[5],at+1)
        setrows(a,rr)
        meta[a]['reference_timing']='User Armor King Combo 1 WEBP: final five contacts, 100ms precision'
    southern=[build(s,'heavy' if s['next'] is None else 'medium') for s in leon_stages if s['direction']=='neutral']
    lead=[clone('Leon','Brad neutral punch '+str(i),i) for i in [1388,1389,1390]]
    for a in lead:meta[a]=manifest[a-3950]
    neutral=lead+southern
    for a,b in zip(neutral,neutral[1:]):link(a,b,.35)
    # Brad's unmodified punch animations need his original continuation
    # frames too; the generic recovery fraction made these punches slower.
    for a,b,n in zip(lead,neutral[1:4],[1388,1389,1390]):
        native=next(row for row in ac[n]['branches'] if row[0]==n+1)
        at,until=native[4:6]
        setrows(a,[[b,0,0,57,0,until,43,0,0,0,0,0,0,0,0],[-2,0,-10,57,at,until,0,0,0,0,0,0,0,0,0]])
        meta[a]['native_continuation_frames']=[at,until]
    # DR reference GIF contacts are about 0.28s and 0.35s apart (70ms
    # sampling). Preserve clip speed; correct the inter-hit commit frames.
    for a,b,at in zip(southern,southern[1:],[16,29]):
        e=end(a)
        assert at<e
        setrows(a,[[b,0,0,57,1,e-1,43,0,0,0,0,0,0,0,0],[-2,0,-10,57,at,e-1,0,0,0,0,0,0,0,0,0]])
        meta[a]['reference_timing']='TK5DR Southern Cross Combination, contacts +17/+21 frames'
    root('Leon',0,neutral[0]);paths['Leon/neutral']=neutral
    def retime(a,speed=1.,recover=1.):
        blob=next(b for c,k,b in banks if k==0x10000+a);p=parse_gyu(blob)
        v=np.stack([decode_track_samples(blob,t) for t in p['records'][0]['tracks']],axis=1)
        ri=struct.unpack_from('<H',actions,a*64+0x38)[0];hi,hn=struct.unpack_from('<HH',reactions,ri*236+0xc0)
        last=active_end(a)
        def tm(t):return round((min(t,last)+max(0,t-last)*recover)/speed)
        e=len(v)-1;sample=np.interp(np.arange(tm(e)+1),[0,tm(last),tm(e)],[0,last,e]);out=np.zeros((len(sample),21,3))
        out[:,0]=np.stack([np.interp(sample,np.arange(len(v)),v[:,0,k]) for k in range(3)],axis=1)
        for k in range(2,21):out[:,k]=Slerp(np.arange(len(v)),Rotation.from_euler('xyz',v[:,k]*2*np.pi))(sample).as_euler('xyz')/(2*np.pi)
        for h in range(hi,hi+hn):
            x,y=struct.unpack_from('<hh',hits,h*18);struct.pack_into('<hh',hits,h*18,tm(x),tm(y))
        rr=rows(a)
        for z in rr:z[4]=tm(z[4]);z[5]=tm(z[5])
        setrows(a,rr);struct.pack_into('<h',actions,a*64+8,tm(end(a)))
        new=encode(out)[0];banks[:]=[(c,k,new if k==0x10000+a else b) for c,k,b in banks]
        meta[a]['trial13_timing']=dict(speed=speed,recovery=recover)
    spa1=next(a for c,g,b,a in spa_rows if c==0 and g==1);spa2=walk(next(a for c,g,b,a in spa_rows if c==0 and g==3))
    retime(spa1,1.2);retime(spa2[-2],.6,1.5);retime(spa2[-1],.7);link(spa2[-2],spa2[-1],.5,automatic=True)
    buff=clone('Leon','Blue counter buff',2712);rec=bytearray.fromhex(ac[2712]['reaction_raw']);struct.pack_into('<H',rec,0xe4,3)
    struct.pack_into('<H',actions,buff*64+0x38,len(reactions)//236);reactions.extend(rec);spa_rows.append((0,2,-1,buff));manifest[-1]['buff']='blue counter'
    D=R/'remaining-additions'
    # Dragunov's unchanged native down string needs private timing records too.
    dd=[clone('Dragunov','Native low reduced recovery '+str(i),i) for i in [2582,2583,2584]]
    for a in dd:
        meta[a]=manifest[a-3950];last=active_end(a);struct.pack_into('<h',actions,a*64+8,last+round((end(a)-last)*.75))
    for a,b in zip(dd,dd[1:]):link(a,b,.6)
    root('Dragunov',2,dd[0]);paths['Dragunov/down']=dd
    # Native combination 5 is attack boost plus armor; preserve activation/cost.
    buff=clone('Heihachi','Purple attack and armor',2909);rec=bytearray.fromhex(ac[2909]['reaction_raw']);struct.pack_into('<H',rec,0xe4,5)
    struct.pack_into('<H',actions,buff*64+0x38,len(reactions)//236);reactions.extend(rec)
    spa_rows.append((53,2,-1,buff));manifest[-1].update(buff='attack and armor',native_buff_template=2005)
    # User confirmed September 29: keep current SPA 1 instead of substituting
    # a different DR strike for the unavailable Sankou Reppu animation.
    # Cammy's native SPA 1 remains intact. Her new side SPA preserves the
    # native six-hit SPA's total damage and charges its cost only once.
    D=R/'cammy-followup';cammy=json.loads((D/'stages.json').read_text())
    native_chain=list(range(2199,2205));total=sum(h[2] for a in native_chain for h in ac[a]['hits'])
    cost=struct.unpack_from('<I',bytes.fromhex(ac[2199]['raw']),16)[0]
    weights=[h['damage'] for s in cammy for h in s['hits']]
    damage=[round(total*w/sum(weights)) for w in weights];damage[-1]+=total-sum(damage)
    groups=[];cursor=0
    for si,s in enumerate(cammy):
        chain=[]
        for j,h in enumerate(s['hits']):
            single=dict(s,key=s['key'],hits=[h])
            kind='heavy' if si==len(cammy)-1 and j==len(s['hits'])-1 else 'stagger'
            if s['finish']=='launch' and j==len(s['hits'])-1:kind='launch'
            a=build(single,kind,spa=(2199,cost if cursor==0 else 0),damage=damage[cursor])
            # Different records reset per-victim hit tracking, but all parts
            # of one source clip keep the exact uninterrupted frame range.
            manifest[-1]['key']=s['key']+f'-contact{j+1}'
            manifest[-1]['contact_index']=cursor+1
            chain.append(a);cursor+=1
        for j,(a,b) in enumerate(zip(chain,chain[1:])):
            at=s['hits'][j+1]['active'][0]-2
            struct.pack_into('<hhh',actions,a*64+4,b,at,at)
            meta[a]['automatic_next']=b
        groups.append(chain)
    for i,(left,right) in enumerate(zip(groups,groups[1:])):
        link(left[-1],right[0],.80 if i>=2 else .35,automatic=True)
    chain=[a for g in groups for a in g]
    spa_rows[:]=[x for x in spa_rows if x[:2]!=(31,3)]
    spa_rows.append((31,3,-1,chain[0]));paths['Cammy/spa2']=chain
    assert sum(damage)==total
    (R/'cammy-spa-report.json').write_text(json.dumps(dict(actions=chain,total_damage=total,damage=damage,cost=cost,spa1_unchanged=True,recovery_between_moves=.8),indent=2))
    report=dict(paths=paths,green_roots=green,runtime_verified=False)
    (R/'remaining-report.json').write_text(json.dumps(report,indent=2))
    return green
