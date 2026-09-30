"""Trial 12 contact/recovery changes layered over the installed Trial 11 data."""
import json, struct
import numpy as np
from scipy.spatial.transform import Rotation, Slerp
from build_idle_candidate import encode, parse_gyu, decode_track_samples

def apply(ram, actions, reactions, hits, branches, manifest, ids, banks, mapping, chars, clone, ac, R, spa_rows):
    meta = {m['id']: m for m in manifest}
    bm = {k-0x10000: b for c,k,b in banks if k >= 0x10000}
    def decode(blob):
        p = parse_gyu(blob)
        return np.stack([decode_track_samples(blob,t) for t in p['records'][0]['tracks']],axis=1)
    def rows(a):
        i,n = struct.unpack_from('<HH',actions,a*64+0x32)
        return [list(struct.unpack_from('<15h',branches,(i+j)*30)) for j in range(n)]
    def setrows(a,rr):
        i=len(branches)//30
        for row in rr: branches.extend(struct.pack('<15h',*row))
        struct.pack_into('<HH',actions,a*64+0x32,i,len(rr));meta[a]['continuation']=rr
    def hr(a):
        ri=struct.unpack_from('<H',actions,a*64+0x38)[0]
        i,n=struct.unpack_from('<HH',reactions,ri*236+0xc0)
        return ri,list(range(i,i+n))
    def private(a,kind=None,height=None):
        ri,hh=hr(a);old=reactions[ri*236:(ri+1)*236];i=len(hits)//18
        for h in hh:hits.extend(hits[h*18:(h+1)*18])
        rec=bytearray(old)
        if kind:
            native={'medium':2786,'heavy':1472,'launch':1494,'sweep':1220}[kind]
            rec=bytearray.fromhex(ac[native]['reaction_raw']);rec[0xc0:0xc6]=old[0xc0:0xc6]
            meta[a]['hit_class']=kind
        struct.pack_into('<H',rec,0xc0,i)
        if height is not None:struct.pack_into('<H',rec,0xc4,height)
        struct.pack_into('<H',actions,a*64+0x38,len(reactions)//236);reactions.extend(rec)
        if height is not None:
            for h in range(i,i+len(hh)):struct.pack_into('<h',hits,h*18+6,height)
        return list(range(i,i+len(hh)))
    def walk(a):
        seen=[];todo=[a]
        while todo:
            x=todo.pop(0)
            if x<3950 or x in seen:continue
            seen.append(x);d=struct.unpack_from('<h',actions,x*64+4)[0]
            todo.extend([d] if d>=3950 else [z[0] for z in rows(x) if z[0]>=3950])
        return seen
    def paths():
        return {(n,d):walk(a) for c,d,b,a in mapping for n,ci in chars.items() if ci==c and b!=3 and (d!=0 or b==0)}
    pp=paths();specs={};radius={};gates={};tails={}
    def tune(a,**kw):
        specs.setdefault(a,dict(speed=1.,startup=1.,recovery=1.,travel=1.));specs[a].update(kw)
    def rad(a,f):radius[a]=f;meta[a]['contact_radius_multiplier']=f
    def skip(a,removed):
        rr=rows(a);nxt=next(z[0] for z in rows(removed) if z[0]>=3950)
        for z in rr:
            if z[0]==removed:z[0]=nxt
        setrows(a,rr)
    def root(n,d,a):
        bearing=0 if d==0 else -1
        mapping[:]=[x for x in mapping if x[:3]!=(chars[n],d,bearing)]
        mapping.append((chars[n],d,bearing,a))
    def duplicate(source,key):
        old=meta[source]
        a=clone(old['character'],key,old['native_template'])
        fresh=manifest[-1];fresh.update({k:v for k,v in old.items() if k not in ['id','key']})
        meta[a]=fresh;actions[a*64:(a+1)*64]=actions[source*64:(source+1)*64]
        bm[a]=bm[source];banks.append((chars[old['character']],0x10000+a,bm[a]))
        return a
    # Latest Kazuya feedback supersedes Trial 11's half-speed side/roundhouse.
    kd,ks,ku=pp['Kazuya',2],pp['Kazuya',3],pp['Kazuya',1]
    tune(kd[1],recovery=.5)
    for a in ks:tune(a,speed=1.4)
    tune(ks[1],speed=1.6,startup=1.6)
    repeat=duplicate(ku[0],'Second Electric Wind God Fist')
    rr=rows(ku[0])
    for z in rr:
        if z[0]==ku[-1]:z[0]=repeat
    setrows(ku[0],rr)
    for a in [ku[0],repeat]:tune(a,speed=.75);private(a,'launch');meta[a]['electric_wind_god_fist']=True
    tune(ku[-1],speed=1.6)
    run1=duplicate(ks[-2],'Running Devastator first');run2=duplicate(ks[-1],'Running Devastator second')
    rr=rows(run1)
    for z in rr:
        if z[0]==ks[-1]:z[0]=run2
    setrows(run1,rr);private(run2,'heavy')
    # Running Devastator uses normal source speed, independent of side tuning.
    for a in [run1,run2]:tune(a,speed=2.)
    mapping[:]=[x for x in mapping if x[:3]!=(16,0,3)];mapping.append((16,0,3,run1))
    dragon=clone('Kazuya','Running Dragon Uppercut',1494);meta[dragon]=manifest[-1]
    bm[dragon]=(R.parent/'revision7/attack-retargets/Kazuya-428.gyu').read_bytes()
    banks.append((16,0x10000+dragon,bm[dragon]))
    ri=len(reactions)//236;hi=len(hits)//18;rec=bytearray.fromhex(ac[1494]['reaction_raw'])
    hits.extend(struct.pack('<9h',22,25,43,1,13,12,-1,-1,-1));struct.pack_into('<HHH',rec,0xc0,hi,1,1)
    reactions.extend(rec);struct.pack_into('<H',actions,dragon*64+0x38,ri)
    struct.pack_into('<h',actions,dragon*64,0);struct.pack_into('<hh',actions,dragon*64+6,0,len(decode(bm[dragon]))-1)
    struct.pack_into('<II',actions,dragon*64+0x28,0,0);struct.pack_into('<H',actions,dragon*64+0x30,0);struct.pack_into('<HH',actions,dragon*64+0x3c,0,0)
    meta[dragon].update(source_ids=[428],hit_class='launch',full_final_recovery=True)
    mapping.append((16,1,3,dragon))
    # Bryan's revised speed targets replace, rather than stack with, Trial 11.
    bn,bu,bs=pp['Bryan',0],pp['Bryan',1],pp['Bryan',3]
    for a in bn[:4]:tune(a,speed=.85/.65)
    for a in bn[-3:]:tune(a,speed=.75/.65)
    tune(bu[1],speed=.75/.5)
    for a in bu[2:4]:tune(a,speed=1.2)
    for a in bs[:2]:tune(a,speed=.75/.5)
    # Leon: two contacts remain distinct actions of one shared two-leg clip.
    ln,ls=pp['Leon',0],pp['Leon',3]
    tune(ln[1],travel=2.);rad(ln[1],2.)
    tune(ls[0],recovery=2.);rad(ls[0],2.)
    for a in ls[1:3]:private(a,'launch')
    private(ls[-1],'heavy');gates[ls[-2]]=1.
    tails[ln[-1]]='Leon'
    # Cammy ordinals refer to the five original inputs before removing #2.
    cu=pp['Cammy',1];skip(cu[0],cu[1]);tune(cu[0],startup=.6)
    tune(cu[3],startup=.5);private(cu[3],'medium',2)
    tune(cu[-1],speed=.5);private(cu[-1],'heavy')
    for a in pp['Cammy',3]:tune(a,travel=2.)
    for a in pp['Cammy',3][3:6]:tune(a,speed=.4)
    for a in pp['Cammy',2][:2]:tune(a,recovery=2.)
    for a in pp['Cammy',2][1:3]:tune(a,speed=.4)
    for a in pp['Cammy',0][:-1]:tune(a,speed=1.35)
    tune(pp['Cammy',0][-2],recovery=1.5)
    tune(pp['Cammy',0][-1],speed=.4,travel=2.);rad(pp['Cammy',0][-1],2.)
    # September 29 follow-up: ordinals now refer to the playable strings.
    current_cu=[cu[0]]+cu[2:]
    tune(current_cu[2],recovery=specs[current_cu[2]]['recovery']*1.35)
    cn,cs,cd=pp['Cammy',0],pp['Cammy',3],pp['Cammy',2]
    tune(cn[2],startup=1/1.25,recovery=1.35)
    tune(cn[3],recovery=specs[cn[3]]['recovery']*1.25)
    tune(cn[4],recovery=specs[cn[4]]['recovery']*1.4)
    for a in cs[-3:]:tune(a,speed=1-(1-.4)*.6)
    tune(cs[2],travel=2*.65)
    for a in cs[3:5]:tune(a,travel=2*1.5)
    private(cs[-1],'launch')
    tune(cd[1],recovery=2/1.6)
    tune(cd[2],speed=.4*1.25,travel=2.)
    # Kiryu retains his native first-up input; the other clips are private.
    ku,kn=pp['Kiryu',1],pp['Kiryu',0]
    tune(ku[1],speed=.5,travel=2.);rad(ku[1],1.5)
    tune(ku[2],travel=2.);tails[ku[-1]]='Kiryu'
    root('Kiryu',0,kn[1])
    for a in kn[1:]:tune(a,travel=2.)
    for a in kn[-3:]:tune(a,speed=.5);rad(a,1.5)
    for a in kn[1:]:
        if any(struct.unpack_from('<h',hits,h*18+6)[0]==2 for h in hr(a)[1]):tune(a,recovery=1.5)
    # Latest Kiryu feedback uses ordinals after removing the first punch.
    current_kn=kn[1:]
    tune(current_kn[2],startup=1/.6,recovery=specs[current_kn[2]]['recovery']*.7)
    for a in current_kn[3:5]:tune(a,speed=.75)
    tune(ku[1],startup=1/.75,recovery=1/1.4,travel=3.);rad(ku[1],2.)
    private(ku[2],'launch')
    buff=clone('Kiryu','Yellow super armor buff',2712);meta[buff]=manifest[-1]
    rec=bytearray.fromhex(ac[2712]['reaction_raw']);struct.pack_into('<H',rec,0xe4,1)
    struct.pack_into('<H',actions,buff*64+0x38,len(reactions)//236);reactions.extend(rec)
    spa_rows[:]=[x for x in spa_rows if x[:2]!=(46,2)]
    spa_rows.append((46,2,-1,buff));meta[buff]['buff']='yellow super armor'
    # Timing-only portions of the other requests can be completed now.
    for a in pp.get(('Dragunov',2),[]):tune(a,recovery=.75)
    for a in pp['Hwoarang',3][:3]:tune(a,speed=.4,recovery=1.5)
    hd=pp['Hwoarang',2];private(hd[0],'medium');private(hd[-1],'launch');gates[hd[0]]=1.
    jn=pp['Jack5',0];skip(jn[2],jn[3]);private(jn[2],'launch')
    for a in jn:
        if a!=jn[3]:tune(a,speed=.7,recovery=.8)
    for a in jn[-2:]:tune(a,speed=.5)
    tune(pp['Jack5',3][-1],startup=2.);private(pp['Jack5',3][-1],'launch')
    current_jn=[a for a in jn if a!=jn[3]]
    tune(current_jn[2],speed=specs[current_jn[2]]['speed']*1.25)
    tune(current_jn[3],speed=specs[current_jn[3]]['speed']*1.30)
    tune(current_jn[-1],startup=1/.65,recovery=.8/1.35)
    tune(pp['Jack5',3][1],travel=1.5)
    for a in pp['Jin',3][:4]:tune(a,travel=2.);rad(a,1.5)
    tune(pp['Jin',0][3],recovery=1.5)
    spa_paths={f'{c}/{d}':walk(a) for c,d,b,a in spa_rows if d in [1,3]}
    leon_spa1=spa_paths['0/1'][0];leon_spa2=spa_paths['0/3']
    onset=min(struct.unpack_from('<h',hits,h*18)[0] for h in hr(leon_spa1)[1])
    # Measured in runtime: this SPA advances at 60 animation frames/second.
    tune(leon_spa1,startup=60./onset)
    private(leon_spa2[-2],'launch');private(leon_spa2[-1],'heavy')
    tune(leon_spa2[-1],travel=2.);rad(leon_spa2[-1],2.)
    for a in spa_paths['36/3']:tune(a,speed=.5,travel=2.)
    rad(spa_paths['36/3'][-1],1.5)
    # Dragonuv's blue counter uses the verified native blue parameter.
    buff=clone('Dragunov','Blue counter buff',2712);meta[buff]=manifest[-1]
    rec=bytearray.fromhex(ac[2712]['reaction_raw']);struct.pack_into('<H',rec,0xe4,3)
    struct.pack_into('<H',actions,buff*64+0x38,len(reactions)//236);reactions.extend(rec)
    spa_rows.append((36,2,-1,buff));meta[buff]['buff']='blue counter'
    from bryan_spa import append as append_bryan_spa
    bryan_spa=append_bryan_spa(actions,reactions,hits,branches,manifest,banks,clone,ac,R,spa_rows)
    spa_paths['43/1']=bryan_spa
    meta.update({m['id']:m for m in manifest})
    bm.update({k-0x10000:b for c,k,b in banks if k>=0x10000 and k-0x10000 in bryan_spa})
    for a in bryan_spa:rad(a,1.5)
    # Snapshot rows before timing so destination start frames use their own map.
    original_rows={a:rows(a) for a in meta};maps={};audit=[]
    for a,s in specs.items():
        assert a in bm,a
        hh=private(a);v=decode(bm[a]);onset=min(struct.unpack_from('<h',hits,h*18)[0] for h in hh)
        last=max(struct.unpack_from('<h',hits,h*18+2)[0] for h in hh);end=len(v)-1
        def tm(t,onset=onset,last=last,s=s):
            return int(round((min(t,onset)*s['startup']+max(0,min(t,last)-onset)+max(0,t-last)*s['recovery'])/s['speed']))
        maps[a]=tm;old=np.array([0,onset,last,end]);new=np.array([tm(t) for t in old]);good=np.r_[True,np.diff(new)>0]
        sample=np.interp(np.arange(tm(end)+1),new[good],old[good]);out=np.zeros((len(sample),21,3))
        out[:,0]=np.array([np.interp(sample,np.arange(len(v)),v[:,0,k]) for k in range(3)]).T
        for k in range(2,21):out[:,k]=Slerp(np.arange(len(v)),Rotation.from_euler('xyz',v[:,k]*2*np.pi))(sample).as_euler('xyz')/(2*np.pi)
        out[:,0,[0,2]]=out[0,0,[0,2]]+(out[:,0,[0,2]]-out[0,0,[0,2]])*s['travel']
        bm[a],err=encode(out)
        for h in hh:
            x,y=struct.unpack_from('<hh',hits,h*18);struct.pack_into('<hh',hits,h*18,tm(x),tm(y))
        struct.pack_into('<h',actions,a*64+8,tm(struct.unpack_from('<h',actions,a*64+8)[0]))
        rr=original_rows[a]
        for z in rr:z[4]=tm(z[4]);z[5]=tm(z[5])
        setrows(a,rr);meta[a]['trial12_timing']=s;meta[a]['encoded_frames']=len(out)
        audit.append(dict(action=a,frames_before=len(v),frames_after=len(out),error=err,**s))
    for a in meta:
        dest,frame=struct.unpack_from('<hh',actions,a*64+4)
        if dest in maps:struct.pack_into('<h',actions,a*64+6,maps[dest](frame))
    # Extend the final SPA contact a few animation frames, still one hit.
    a=leon_spa2[-1];hh=hr(a)[1];end=len(decode(bm[a]))-1
    for h in hh:
        x,y=struct.unpack_from('<hh',hits,h*18);struct.pack_into('<hh',hits,h*18,max(1,x-3),min(end-1,y+6))
    # Append the actual source get-up. Blend only the junction, never the torso texture/mesh.
    for a,name in tails.items():
        v=decode(bm[a]);tail=decode((R/'recovery-candidates/attack-retargets'/f'{name}-kip-up.gyu').read_bytes())
        tail[:,0,[0,2]]+=v[-1,0,[0,2]]-tail[0,0,[0,2]]
        join=np.zeros((6,21,3));join[:,0]=np.linspace(v[-1,0],tail[0,0],8)[1:-1]
        for k in range(2,21):
            join[:,k]=Slerp([0,1],Rotation.from_euler('xyz',np.stack([v[-1,k],tail[0,k]])*2*np.pi))(np.linspace(0,1,8)[1:-1]).as_euler('xyz')/(2*np.pi)
        out=np.concatenate([v,join,tail]);bm[a],err=encode(out);meta[a]['recovery_animation']='Armor King Kg_Rol_lrkE'
        meta[a]['encoded_frames']=len(out)
    # Full final recovery also applies to custom SPA finishers.
    allpaths=list(paths().values())+list(spa_paths.values())+[walk(run1),[dragon]]
    for a in set(x for chain in allpaths for x in chain):
        if a not in bm:continue
        if struct.unpack_from('<h',actions,a*64+4)[0]>=3950 or any(z[0]>=3950 for z in rows(a)):continue
        struct.pack_into('<h',actions,a*64+8,len(decode(bm[a]))-1);meta[a]['full_final_recovery']=True
    for a,fraction in gates.items():
        end=len(decode(bm[a]))-1;last=max(struct.unpack_from('<h',hits,h*18+2)[0] for h in hr(a)[1])
        at=min(end-1,last+int(round((end-last)*fraction)));rr=rows(a)
        for z in rr:
            z[5]=end-1
            if z[0]<0:z[4]=at
        setrows(a,rr);meta[a]['recovery_gate']=dict(commit=at,end=end)
    throw=ids['Kazuya','Double Face Kick'];v=decode(bm[throw]);last=len(v)-1
    while last>63 and np.max(np.abs(v[last]-v[last-1]))<1e-5:last-=1
    newend=62+int(round((last-62)*.75));sample=np.r_[np.arange(63),np.linspace(62,last,newend-62+1)[1:]]
    out=np.zeros((len(sample),21,3));out[:,0]=np.array([np.interp(sample,np.arange(len(v)),v[:,0,k]) for k in range(3)]).T
    for k in range(2,21):out[:,k]=Slerp(np.arange(len(v)),Rotation.from_euler('xyz',v[:,k]*2*np.pi))(sample).as_euler('xyz')/(2*np.pi)
    bm[throw],err=encode(out);struct.pack_into('<h',actions,throw*64+8,newend)
    meta[throw]['trimmed_throw_recovery']=dict(old_end=len(v)-1,last_moving_frame=last,new_end=newend,contact_frames_unchanged=[25,62])
    banks[:]=[(c,k,bm.get(k-0x10000,b)) for c,k,b in banks]
    # Native submission up-throw 3309 pairs with victim 419. Their motions
    # 1490/1491 are absent from Cammy's pack; keep the intact native paired
    # records and provide both exact native animation banks.
    banks.extend([(31,0x10000+3309,(R/'cammy-grab-source/1490.gyu').read_bytes()),
                  (0xfffffffe,0x10000+419,(R/'cammy-grab-source/1491.gyu').read_bytes())])
    protected=[x for chain in spa_paths.values() for x in chain]
    for a in protected:meta[a]['spa_protection']=True
    (R/'contact-followup-report.json').write_text(json.dumps(dict(paths={f'{n}/{d}':v for (n,d),v in paths().items()},spas=spa_paths,retiming=audit,radius=radius,protected=protected,recovery_tails=tails,blue_counter_action=buff,kazuya_running={0:walk(run1),1:[dragon]},kazuya_electric_repeat=repeat,runtime_verified=False),indent=2))
    return radius,protected
