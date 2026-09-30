"""September 29 Jack feedback, relative to the preceding candidate."""
import json, struct
import numpy as np
from scipy.spatial.transform import Rotation, Slerp
from build_idle_candidate import encode, parse_gyu, decode_track_samples

def apply(actions,reactions,hits,branches,manifest,banks,mapping,ac,R,radius):
    meta={m['id']:m for m in manifest}
    def rows(a):
        i,n=struct.unpack_from('<HH',actions,a*64+0x32)
        return [list(struct.unpack_from('<15h',branches,(i+j)*30)) for j in range(n)]
    def walk(a):
        todo=[a];seen=[]
        while todo:
            a=todo.pop(0)
            if a<3950 or a in seen:continue
            seen.append(a);n=struct.unpack_from('<h',actions,a*64+4)[0]
            todo.extend([n] if n>=3950 else [r[0] for r in rows(a) if r[0]>=3950])
        return seen
    neutral=walk(next(a for c,d,b,a in mapping if (c,d,b)==(45,0,0)))
    specs={a:dict(speed=1.1) for a in neutral}
    specs.update({4199:dict(startup=1/.65,recovery=1.15,travel=.55),4200:dict(startup=1/.65,recovery=1.15)})
    for a in [4205,4206,4207]:
        specs[a]=dict(recovery=1/1.35,travel=2.3 if a==4207 else 1.4)
        radius[a]=radius.get(a,1.)*1.5
        meta[a]['contact_radius_multiplier']=radius[a]
    specs[4209]=dict(travel=.75)
    # Green-mode-only King records; base moveset remains native.
    for a in [4225,4226,4227]:specs[a]=dict(startup=1/.75,recovery=1/1.25)
    specs[4029]=dict(startup=1/.9)
    for a in range(4177,4188):specs[a]=dict(speed=1.25)
    bryan_middle=list(range(4023,4028))+list(range(4030,4034))
    for a in bryan_middle:specs.setdefault(a,{})
    specs[4129]=dict(recovery=.65)
    specs[4245]=dict(recovery=1/1.25)
    radius[4245]=radius.get(4245,1.)*1.5
    meta[4245]['contact_radius_multiplier']=radius[4245]
    audit=[];maps={}
    for a,kw in specs.items():
        s=dict(speed=1.,startup=1.,recovery=1.,travel=1.);s.update(kw)
        ri=struct.unpack_from('<H',actions,a*64+0x38)[0]
        rec=bytearray(reactions[ri*236:(ri+1)*236]);hi,hn=struct.unpack_from('<HH',rec,0xc0)
        hh=[list(struct.unpack_from('<9h',hits,(hi+j)*18)) for j in range(hn)]
        if a==neutral[2] or a==4200:
            native=1783 if a==neutral[2] else 1220
            rec[:0xc0]=bytes.fromhex(ac[native]['reaction_raw'])[:0xc0]
            meta[a]['hit_class']='launch' if a==neutral[2] else 'sweep'
            if a==4200:
                struct.pack_into('<H',rec,0xc4,2)
                for h in hh:h[3]=2
        if a==4029:
            rec[:0xc0]=bytes.fromhex(ac[2786]['reaction_raw'])[:0xc0]
            for h in hh:h[2]=max(h[2],30)
            meta[a]['hit_class']='medium'
        elif a in bryan_middle:
            # Longer native standing stagger; preserve authored damage and
            # airborne reactions so this does not add knockdown or relaunch.
            medium=bytes.fromhex(ac[2786]['reaction_raw'])
            rec[:16]=medium[:16]
            meta[a]['standing_stagger_template']=2786
        blob=next(b for c,k,b in banks if k==0x10000+a)
        p=parse_gyu(blob);v=np.stack([decode_track_samples(blob,t) for t in p['records'][0]['tracks']],axis=1)
        onset=min(h[0] for h in hh);last=max(h[1] for h in hh)
        def tm(t,s=s,onset=onset,last=last):
            return round((min(t,onset)*s['startup']+max(0,min(t,last)-onset)+max(0,t-last)*s['recovery'])/s['speed'])
        maps[a]=tm;e=len(v)-1;old=np.array([0,onset,last,e]);new=np.array([tm(t) for t in old]);good=np.r_[True,np.diff(new)>0]
        sample=np.interp(np.arange(tm(e)+1),new[good],old[good]);out=np.zeros((len(sample),21,3))
        out[:,0]=np.array([np.interp(sample,np.arange(len(v)),v[:,0,k]) for k in range(3)]).T
        for k in range(2,21):out[:,k]=Slerp(np.arange(len(v)),Rotation.from_euler('xyz',v[:,k]*2*np.pi))(sample).as_euler('xyz')/(2*np.pi)
        out[:,0,[0,2]]=out[0,0,[0,2]]+(out[:,0,[0,2]]-out[0,0,[0,2]])*s['travel']
        newblob,err=encode(out);banks[:]=[(c,k,newblob if k==0x10000+a else b) for c,k,b in banks]
        struct.pack_into('<H',rec,0xc0,len(hits)//18)
        for h in hh:h[0]=tm(h[0]);h[1]=tm(h[1]);hits.extend(struct.pack('<9h',*h))
        struct.pack_into('<H',actions,a*64+0x38,len(reactions)//236);reactions.extend(rec)
        rr=rows(a);bi=len(branches)//30
        for row in rr:row[4]=tm(row[4]);row[5]=tm(row[5]);branches.extend(struct.pack('<15h',*row))
        struct.pack_into('<HH',actions,a*64+0x32,bi,len(rr))
        struct.pack_into('<h',actions,a*64+8,tm(struct.unpack_from('<h',actions,a*64+8)[0]))
        meta[a].update(latest_jack_timing=s,encoded_frames=len(out),continuation=rr)
        audit.append(dict(action=a,frames_before=len(v),frames_after=len(out),codec_error=err,**s))
    for a in meta:
        dest,frame=struct.unpack_from('<hh',actions,a*64+4)
        if dest in maps:struct.pack_into('<h',actions,a*64+6,maps[dest](frame))
    (R/'jack-latest-report.json').write_text(json.dumps(dict(neutral=neutral,retiming=audit,third_spa_travel=2.3,runtime_verified=False),indent=2))
